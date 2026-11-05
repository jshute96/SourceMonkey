#!/usr/bin/env node
// The `sm-dev` package exists so `npx sm-dev` and `npm install -g sm-dev`
// work: npx looks a package up by the name given, and the command lives
// in `sourcemonkey`. Importing its launcher runs it, which runs the
// project's own copy of sm-dev when there is one (see
// src/harness/launcher.ts).
import 'sourcemonkey/harness/launcher';
