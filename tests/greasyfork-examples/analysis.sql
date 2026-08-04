-- Analysis queries over corpus.db (built by build-db.mjs).
--
-- Each report is one statement introduced by `-- @report <title>`, optionally
-- followed by `-- @note <text>`. report.mjs runs them in order and renders each
-- result as an HTML table, so the two files stay in sync by construction.
-- Run them ad hoc with:  sqlite3 tests/greasyfork-examples/corpus.db < analysis.sql

-- @report Corpus totals
-- @note One row per kind of file. "On disk" counts what was actually downloaded; sizes cover only those.
SELECT 'Scripts' AS kind,
       COUNT(*) AS files,
       SUM(size IS NOT NULL) AS on_disk,
       SUM(size) AS total_size,
       CAST(AVG(size) AS INT) AS avg_size,
       MIN(size) AS min_size,
       MAX(size) AS max_size
FROM Scripts
UNION ALL
SELECT 'Require files', COUNT(*), SUM(size IS NOT NULL), SUM(size), CAST(AVG(size) AS INT), MIN(size), MAX(size)
FROM RequiresFiles
UNION ALL
SELECT 'Resource files', COUNT(*), SUM(size IS NOT NULL), SUM(size), CAST(AVG(size) AS INT), MIN(size), MAX(size)
FROM ResourceFiles;

-- @report Dependency reference totals
-- @note A "reference" is one script naming one URL. Unique files are far fewer, which is what the dedup tables below quantify.
SELECT 'Require' AS dependency,
       (SELECT COUNT(*) FROM ScriptRequiresFiles) AS references_,
       (SELECT COUNT(*) FROM RequiresFiles) AS unique_urls,
       (SELECT COUNT(DISTINCT script_id) FROM ScriptRequiresFiles) AS scripts_using
UNION ALL
SELECT 'Resource',
       (SELECT COUNT(*) FROM ScriptResourcesFiles),
       (SELECT COUNT(*) FROM ResourceFiles),
       (SELECT COUNT(DISTINCT script_id) FROM ScriptResourcesFiles);

-- @report Size distribution
-- @note Counts of files falling in each size band, by kind.
WITH all_files AS (
  SELECT 'scripts' AS kind, size FROM Scripts WHERE size IS NOT NULL
  UNION ALL SELECT 'requires', size FROM RequiresFiles WHERE size IS NOT NULL
  UNION ALL SELECT 'resources', size FROM ResourceFiles WHERE size IS NOT NULL
)
SELECT CASE
         WHEN size <          1024 THEN '< 1 KB'
         WHEN size <      4 * 1024 THEN '1 – 4 KB'
         WHEN size <     16 * 1024 THEN '4 – 16 KB'
         WHEN size <     64 * 1024 THEN '16 – 64 KB'
         WHEN size <    256 * 1024 THEN '64 – 256 KB'
         WHEN size <   1024 * 1024 THEN '256 KB – 1 MB'
         ELSE                           '>= 1 MB'
       END AS band,
       SUM(kind = 'scripts') AS scripts,
       SUM(kind = 'requires') AS require_files,
       SUM(kind = 'resources') AS resource_files
FROM all_files
GROUP BY band
ORDER BY MIN(size);

-- @report Size percentiles
-- @note Median and tails per kind, for a sense of how skewed each population is. Only files on disk count.
WITH all_files AS (
  SELECT 1 AS ord, 'Scripts' AS kind, size FROM Scripts WHERE size IS NOT NULL
  UNION ALL SELECT 2, 'Require files', size FROM RequiresFiles WHERE size IS NOT NULL
  UNION ALL SELECT 3, 'Resource files', size FROM ResourceFiles WHERE size IS NOT NULL
),
ranked AS (
  SELECT ord, kind, size,
         ROW_NUMBER() OVER (PARTITION BY kind ORDER BY size) AS rn,
         COUNT(*) OVER (PARTITION BY kind) AS n
  FROM all_files
)
-- max(1, …) keeps the low percentiles on a real row for the smaller populations,
-- where integer division would otherwise land on row 0 and yield NULL.
SELECT kind,
       MIN(n) AS files,
       MAX(CASE WHEN rn = max(1, (n * 10) / 100) THEN size END) AS p10_size,
       MAX(CASE WHEN rn = max(1, (n * 25) / 100) THEN size END) AS p25_size,
       MAX(CASE WHEN rn = max(1, (n * 50) / 100) THEN size END) AS median_size,
       MAX(CASE WHEN rn = max(1, (n * 75) / 100) THEN size END) AS p75_size,
       MAX(CASE WHEN rn = max(1, (n * 90) / 100) THEN size END) AS p90_size,
       MAX(CASE WHEN rn = max(1, (n * 99) / 100) THEN size END) AS p99_size
FROM ranked
GROUP BY kind
ORDER BY MIN(ord);

-- @report Require files by reference count
-- @note "Single size" stores each file once; "replicated size" is what it would cost if every referencing script kept its own copy. The gap is what sharing buys.
WITH refs AS (
  SELECT r.url, r.size, COUNT(*) AS ref_count
  FROM RequiresFiles r JOIN ScriptRequiresFiles s ON s.url = r.url
  GROUP BY r.url
)
SELECT ref_count AS referencing_scripts,
       COUNT(*) AS files,
       SUM(size IS NOT NULL) AS on_disk,
       SUM(size) AS single_size,
       SUM(size * ref_count) AS replicated_size
FROM refs
GROUP BY ref_count
ORDER BY ref_count DESC;

-- @report Resource files by reference count
WITH refs AS (
  SELECT r.url, r.size, COUNT(*) AS ref_count
  FROM ResourceFiles r JOIN ScriptResourcesFiles s ON s.url = r.url
  GROUP BY r.url
)
SELECT ref_count AS referencing_scripts,
       COUNT(*) AS files,
       SUM(size IS NOT NULL) AS on_disk,
       SUM(size) AS single_size,
       SUM(size * ref_count) AS replicated_size
FROM refs
GROUP BY ref_count
ORDER BY ref_count DESC;

-- @report Most-shared require files
-- @note The top 25 libraries by how many scripts pull them in.
SELECT s.url, COUNT(*) AS referencing_scripts, r.size
FROM ScriptRequiresFiles s JOIN RequiresFiles r ON r.url = s.url
GROUP BY s.url
ORDER BY referencing_scripts DESC, r.size DESC
LIMIT 25;

-- @report Dependency hosts
-- @note Where dependencies are served from, by distinct URL count.
WITH hosts AS (
  SELECT 'require' AS kind, url FROM RequiresFiles
  UNION ALL SELECT 'resource', url FROM ResourceFiles
)
SELECT substr(rest, 1, instr(rest || '/', '/') - 1) AS host,
       SUM(kind = 'require') AS require_urls,
       SUM(kind = 'resource') AS resource_urls,
       COUNT(*) AS total_urls
FROM (SELECT kind, substr(url, instr(url, '://') + 3) AS rest FROM hosts)
GROUP BY host
ORDER BY total_urls DESC
LIMIT 25;

-- @report Requires per script
-- @note How many distinct @require URLs a script names. Scripts with none are the large majority.
-- @note The 0 row also holds the 9 scripts whose metadata block does not parse, which declare nothing we can see.
WITH counts AS (
  SELECT s.id, (SELECT COUNT(*) FROM ScriptRequiresFiles r WHERE r.script_id = s.id) AS n
  FROM Scripts s
)
SELECT n AS requires_in_script, COUNT(*) AS scripts
FROM counts
GROUP BY n
ORDER BY n;

-- @report Header fields, ignoring locale suffixes
-- @note Every metadata tag, counted by how many scripts use it and how many lines it accounts for. `@description:ar` counts under `description` here.
SELECT header_field,
       COUNT(DISTINCT script_id) AS scripts,
       COUNT(*) AS occurrences,
       COUNT(DISTINCT CASE WHEN header_field_suffix <> '' THEN header_field_suffix END) AS distinct_suffixes
FROM ScriptHeaders
GROUP BY header_field
ORDER BY scripts DESC, occurrences DESC;

-- @report Header fields with their locale suffixes
-- @note Localized fields only, keyed on the full field so `@name:zh-CN` is its own row. Top 40 by occurrence; unlocalized tags are in the report above.
SELECT header_field_full,
       header_field,
       header_field_suffix,
       COUNT(DISTINCT script_id) AS scripts,
       COUNT(*) AS occurrences
FROM ScriptHeaders
WHERE header_field_suffix <> ''
GROUP BY header_field_full
ORDER BY occurrences DESC
LIMIT 40;

-- @report Localized tags summary
-- @note Which tags get translated at all, and into how many locales.
SELECT header_field,
       COUNT(DISTINCT header_field_suffix) AS locales,
       COUNT(DISTINCT script_id) AS scripts,
       COUNT(*) AS occurrences
FROM ScriptHeaders
WHERE header_field_suffix <> ''
GROUP BY header_field
ORDER BY occurrences DESC;

-- @report @grant values
-- @note Every distinct permission requested, and how many scripts request it.
SELECT CASE WHEN trim(argument) = '' THEN '(empty)' ELSE trim(argument) END AS grant_value,
       COUNT(DISTINCT script_id) AS scripts,
       COUNT(*) AS occurrences
FROM ScriptHeaders
WHERE header_field = 'grant' AND header_field_suffix = ''
GROUP BY grant_value
ORDER BY scripts DESC;

-- @report Grants per script
-- @note `@grant none` counts as one. Scripts with no @grant line at all are the 0 row.
-- @note That 0 row also holds the scripts whose metadata block does not parse.
WITH counts AS (
  SELECT s.id,
         (SELECT COUNT(*) FROM ScriptHeaders h WHERE h.script_id = s.id AND h.header_field = 'grant') AS n
  FROM Scripts s
)
SELECT n AS grants_in_script, COUNT(*) AS scripts
FROM counts
GROUP BY n
ORDER BY n;

-- @report Enum-valued headers
-- @note Tags whose argument comes from a small fixed set. A flag tag written bare (e.g. `@noframes`) shows as (flag).
SELECT header_field,
       CASE WHEN trim(argument) = '' THEN '(flag)' ELSE lower(trim(argument)) END AS value,
       COUNT(DISTINCT script_id) AS scripts,
       COUNT(*) AS occurrences
FROM ScriptHeaders
WHERE header_field IN ('run-at', 'inject-into', 'sandbox', 'noframes', 'unwrap', 'nocompat', 'top-level-await')
  AND header_field_suffix = ''
GROUP BY header_field, value
ORDER BY header_field, scripts DESC;

-- @report @antifeature categories
-- @note The category is the first token; the rest is a human-readable explanation.
SELECT lower(CASE WHEN instr(trim(argument), ' ') = 0 THEN trim(argument)
                  ELSE substr(trim(argument), 1, instr(trim(argument), ' ') - 1) END) AS category,
       COUNT(DISTINCT script_id) AS scripts,
       COUNT(*) AS occurrences
FROM ScriptHeaders
-- Localized `@antifeature:xx` lines restate one declaration in another
-- language; counting them would inflate occurrences with translations.
WHERE header_field = 'antifeature' AND header_field_suffix = ''
GROUP BY category
ORDER BY scripts DESC;

-- @report @license values
-- @note Free-form in practice, so this is the top 20 spellings rather than a closed set.
SELECT trim(argument) AS license, COUNT(DISTINCT script_id) AS scripts
FROM ScriptHeaders
WHERE header_field = 'license' AND header_field_suffix = '' AND trim(argument) <> ''
GROUP BY license
ORDER BY scripts DESC
LIMIT 20;

-- @report Scripts without a parseable metadata block
-- @note Downloaded bodies where the ==UserScript== / ==/UserScript== pair is missing — user styles and a few malformed scripts.
SELECT s.id, s.name, s.size, s.info_page
FROM Scripts s
WHERE s.size IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ScriptHeaders h WHERE h.script_id = s.id)
ORDER BY s.size DESC;

-- @report Largest scripts
SELECT id, name, size, total_installs
FROM Scripts
WHERE size IS NOT NULL
ORDER BY size DESC
LIMIT 20;

-- @report Match patterns per script
-- @note How many @match and @include lines a script carries. Scripts with none of a given tag are the 0 row.
-- @note The 0 rows also hold the scripts whose metadata block does not parse.
WITH counts AS (
  SELECT s.id,
         (SELECT COUNT(*) FROM ScriptMatches m WHERE m.script_id = s.id AND m.header_field = 'match') AS matches,
         (SELECT COUNT(*) FROM ScriptMatches m WHERE m.script_id = s.id AND m.header_field = 'include') AS includes
  FROM Scripts s
)
SELECT lines_in_script,
       SUM(kind = 'match') AS scripts_by_match,
       SUM(kind = 'include') AS scripts_by_include
FROM (SELECT 'match' AS kind, matches AS lines_in_script FROM counts
      UNION ALL SELECT 'include', includes FROM counts)
GROUP BY lines_in_script
ORDER BY lines_in_script;

-- @report Pattern shapes
-- @note Judged on the host and path only. Absolute patterns contain no wildcard; a prefix has one trailing `*`; an inner glob has a `*` before the end, so it can match in the middle of a URL.
-- @note A `*://` scheme is excluded from this judgement — it is just the normal way to write "http or https" and would otherwise push every `*://site.com/*` into the inner-glob bucket. Scheme wildcards are counted separately below.
SELECT shape,
       SUM(header_field = 'match') AS match_lines,
       SUM(header_field = 'include') AS include_lines,
       COUNT(*) AS total_lines,
       COUNT(DISTINCT script_id) AS scripts
FROM ScriptMatches
GROUP BY shape
ORDER BY total_lines DESC;

-- @report Scheme wildcards
-- @note How the scheme itself is written, independent of the host/path shape above. `*` and `http*` both mean "http or https" in practice.
SELECT CASE WHEN scheme = '' THEN '(none written)' ELSE scheme END AS scheme,
       MAX(scheme_glob) AS is_wildcard,
       COUNT(*) AS lines,
       COUNT(DISTINCT script_id) AS scripts
FROM ScriptMatches
WHERE shape <> 'regex'
GROUP BY scheme
ORDER BY lines DESC;

-- @report Where the wildcard falls
-- @note Which component of a pattern carries a `*`. A host wildcard is the one that widens a script's reach across sites.
-- @note Regex `@include` lines have no glob components at all, so they get their own row rather than counting as "no wildcard".
SELECT CASE
         WHEN shape = 'regex' THEN 'regex (not a glob)'
         WHEN scheme_glob = 0 AND host_glob = 0 AND path_glob = 0 THEN 'no wildcard'
         WHEN host_glob = 1 AND host_pattern = '*' THEN 'any host'
         WHEN host_glob = 1 THEN 'host wildcard (subdomain)'
         WHEN path_glob = 1 AND scheme_glob = 1 THEN 'scheme + path'
         WHEN path_glob = 1 THEN 'path only'
         ELSE 'scheme only'
       END AS wildcard_in,
       COUNT(*) AS lines,
       COUNT(DISTINCT script_id) AS scripts
FROM ScriptMatches
GROUP BY wildcard_in
ORDER BY lines DESC;

-- @report Most-targeted sites
-- @note Sites a pattern resolves to, counting each script once. `*.youtube.com` attributes to youtube.com — one leading wildcard label is stripped, nothing else.
-- @note Granularity is the hostname as written, so www.youtube.com and youtube.com are separate rows (as are dev./sandbox. subdomains). Folding to a registrable domain would need a public-suffix list.
SELECT site,
       COUNT(DISTINCT script_id) AS scripts,
       COUNT(*) AS pattern_lines
FROM ScriptMatches
WHERE site IS NOT NULL
GROUP BY site
ORDER BY scripts DESC, pattern_lines DESC
LIMIT 30;

-- @report Scripts per site
-- @note How many sites are targeted by exactly N scripts. The long tail of one-script sites is the bulk of the corpus.
WITH per_site AS (
  SELECT site, COUNT(DISTINCT script_id) AS scripts
  FROM ScriptMatches WHERE site IS NOT NULL GROUP BY site
)
SELECT scripts AS scripts_targeting_site, COUNT(*) AS sites
FROM per_site
GROUP BY scripts
ORDER BY scripts;

-- @report Sites per script
-- @note How many distinct sites one script targets. Scripts whose patterns resolve to no single site (e.g. `*://*/*` only) count as 0.
WITH per_script AS (
  SELECT s.id, (SELECT COUNT(DISTINCT site) FROM ScriptMatches m WHERE m.script_id = s.id AND m.site IS NOT NULL) AS sites
  FROM Scripts s
)
SELECT sites AS sites_per_script, COUNT(*) AS scripts
FROM per_script
GROUP BY sites
ORDER BY sites;

-- @report Scripts that match any site
-- @note Patterns with a bare `*` host run on every page. These are the ones whose cost is paid on every navigation.
SELECT header_field,
       COUNT(*) AS lines,
       COUNT(DISTINCT script_id) AS scripts
FROM ScriptMatches
WHERE host_pattern = '*'  -- covers `*`, `*://*/*`, and `<all_urls>` alike
GROUP BY header_field
ORDER BY scripts DESC;
