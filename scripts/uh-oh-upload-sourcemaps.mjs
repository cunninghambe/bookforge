// GENERATED FILE - vendored from uh-oh scripts/vendor-sourcemap-uploader.mjs (uh-oh-upload-sourcemaps.mjs).
// Do not hand-edit. Regenerate: node scripts/vendor-sourcemap-uploader.mjs --out scripts/uh-oh-upload-sourcemaps.mjs
// Self-contained: zero dependencies, node:fs/path/process + built-in fetch only.
//
// LOCAL DIVERGENCE (bookforge A23.9 / D192, 2026-07-25): browser source map
// deletion was inverted to be the DEFAULT, with a new --keep-browser-maps
// opt-out; --delete-browser-maps is kept as a no-op alias so existing deploy
// commands keep working. The upstream generator lives in a different repo and
// does not carry this change, so a regeneration WILL silently revert it. Re-apply
// the inversion (parseArgs plus the deletion block near the end) after any
// regeneration, or the unsafe outcome goes back to being one forgotten flag away.

// uh-oh source map uploader (self-contained, zero dependencies).
//
// Uploads a Next.js build's source maps to a self-hosted uh-oh server so
// production stack traces symbolicate. Safe to run in every deploy: when uh-oh
// is not configured (the env vars below are unset) it prints one line and
// exits 0 - a no-op - so a deploy without uh-oh configured never breaks.
//
// Usage:
//   node uh-oh-upload-sourcemaps.mjs --dir <.next> --release <version+build> [options]
//
// Options:
//   --dir <path>            Next.js build dir (holds static/ and server/). Required.
//   --release <ver+build>   Release identifier, e.g. 1.4.2+37. Required.
//   --keep-browser-maps     Keep the uploaded static/**/*.js.map files on disk.
//                           By DEFAULT they are deleted after ALL uploads
//                           succeed (never on partial failure), so a public
//                           deploy does not serve the app's client source.
//   --delete-browser-maps   Accepted and ignored: deletion is the default now.
//                           Kept so existing deploy commands do not break.
//   --dry-run               List what would be uploaded; make no network calls.
//   --require               Treat missing env as an error (exit 1) instead of a
//                           no-op, for CI that wants to enforce uploads.
//
// Environment:
//   UH_OH_SERVER_URL    Base URL of the uh-oh server, e.g. https://uh-oh.example.com
//   UH_OH_SYMBOL_TOKEN  Symbol upload token (sent as the X-Uh-Oh-Symbol-Token header).
//   UH_OH_PROJECT       Project slug.

import { readdirSync, statSync, readFileSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import process from 'node:process';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB, mirrors the server cap.
const TOKEN_HEADER = 'X-Uh-Oh-Symbol-Token';

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

function mb(size) {
  return (size / (1024 * 1024)).toFixed(1);
}

function parseArgs(argv) {
  // D192: deletion is the default. --keep-browser-maps is the opt-out, and
  // --delete-browser-maps is a no-op alias for the commands that still pass it.
  const args = { keepBrowserMaps: false, dryRun: false, require: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') {
      i++;
      args.dir = argv[i];
    } else if (a === '--release') {
      i++;
      args.release = argv[i];
    } else if (a === '--keep-browser-maps') {
      args.keepBrowserMaps = true;
    } else if (a === '--delete-browser-maps') {
      // No-op alias: this is the default behavior now.
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--require') {
      args.require = true;
    }
  }
  return args;
}

function parseRelease(release) {
  if (typeof release !== 'string') return null;
  const plus = release.lastIndexOf('+');
  if (plus <= 0 || plus === release.length - 1) return null;
  return { version: release.slice(0, plus), build: release.slice(plus + 1) };
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // A missing subdir is normal (a static export has no server/ output).
    return [];
  }
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      for (const child of walk(full)) out.push(child);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// subdir is both the on-disk folder under <baseDir> and the bundlePath prefix:
// "static/..." for browser bundles, "server/..." for server bundles. The
// bundlePath is POSIX-style, relative, no leading slash, with .map stripped.
function findMaps(baseDir, subdir, platform) {
  const root = join(baseDir, subdir);
  const results = [];
  for (const absPath of walk(root)) {
    if (!absPath.endsWith('.js.map')) continue;
    const rel = absPath
      .slice(root.length)
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/')
      .replace(/\.map$/, '');
    results.push({ platform: platform, absPath: absPath, bundlePath: subdir + '/' + rel });
  }
  return results;
}

async function apiGetJson(url, token) {
  const headers = {};
  headers[TOKEN_HEADER] = token;
  const res = await fetch(url, { method: 'GET', headers: headers });
  if (!res.ok) throw new Error('GET ' + url + ' returned ' + res.status);
  return res.json();
}

// Idempotent release upsert (POST /api/projects/:id/releases). Deploy
// pipelines run BEFORE the first crash event, so a release row may not exist
// yet; this creates (201) or resolves (200) it, either way returning the row.
async function upsertRelease(serverBase, token, projectId, version, build, platform) {
  const headers = {};
  headers[TOKEN_HEADER] = token;
  headers['content-type'] = 'application/json';
  const url = serverBase + '/api/projects/' + projectId + '/releases';
  const res = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ version: version, build: build, platform: platform }),
  });
  if (!res.ok) throw new Error('POST ' + url + ' returned ' + res.status);
  const data = await res.json();
  if (!data || !data.release || !data.release.id) {
    throw new Error('POST ' + url + ' returned a malformed release');
  }
  return data.release.id;
}

async function uploadOne(serverBase, token, releaseId, item) {
  const form = new FormData();
  const buf = readFileSync(item.absPath);
  // Fields BEFORE the file part: the server only sees multipart fields that
  // arrive ahead of the file in the stream, so a large map appended first
  // starves platform/bundlePath and gets a 400.
  form.append('platform', item.platform);
  form.append('bundlePath', item.bundlePath);
  form.append('file', new Blob([buf]), basename(item.absPath));
  const headers = {};
  headers[TOKEN_HEADER] = token;
  const res = await fetch(serverBase + '/api/releases/' + releaseId + '/symbols', {
    method: 'POST',
    headers: headers,
    body: form,
  });
  return res.ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = process.env.UH_OH_SERVER_URL;
  const token = process.env.UH_OH_SYMBOL_TOKEN;
  const project = process.env.UH_OH_PROJECT;

  if (!server || !token || !project) {
    process.stderr.write(
      'uh-oh: source map upload skipped (set UH_OH_SERVER_URL, UH_OH_SYMBOL_TOKEN, and UH_OH_PROJECT to enable)\n',
    );
    return args.require ? 1 : 0;
  }

  if (!args.dir) {
    process.stderr.write('uh-oh: --dir <.next path> is required\n');
    return 1;
  }
  const parsed = parseRelease(args.release);
  if (!parsed) {
    process.stderr.write('uh-oh: --release <version+build> is required (for example 1.4.2+37)\n');
    return 1;
  }

  const serverBase = server.replace(/\/+$/, '');
  const webMaps = findMaps(args.dir, 'static', 'web');
  const nodeMaps = findMaps(args.dir, 'server', 'node');
  const all = webMaps.concat(nodeMaps);

  if (all.length === 0) {
    process.stdout.write('uh-oh: no source maps found under ' + args.dir + '\n');
    return 0;
  }

  if (args.dryRun) {
    let web = 0;
    let node = 0;
    let skipped = 0;
    for (const item of all) {
      let size;
      try {
        size = statSync(item.absPath).size;
      } catch {
        process.stdout.write('uh-oh: cannot read ' + item.absPath + '\n');
        continue;
      }
      if (size > MAX_UPLOAD_BYTES) {
        process.stdout.write(
          'uh-oh: skipping ' + item.bundlePath + ' (' + mb(size) + ' MB exceeds 50 MB)\n',
        );
        skipped++;
        continue;
      }
      process.stdout.write('[dry-run] ' + item.platform + ' ' + item.bundlePath + '\n');
      if (item.platform === 'web') web++;
      else node++;
    }
    process.stdout.write(
      'uh-oh: would upload ' + web + ' web + ' + node + ' node maps (' + skipped + ' skipped)\n',
    );
    return 0;
  }

  let projectId;
  try {
    const data = await apiGetJson(serverBase + '/api/projects', token);
    const list = (data && data.projects) || [];
    const found = list.find((p) => p.slug === project);
    if (!found) {
      process.stderr.write('uh-oh: project ' + project + ' not found\n');
      return 1;
    }
    projectId = found.id;
  } catch (e) {
    process.stderr.write('uh-oh: failed to fetch projects: ' + errMsg(e) + '\n');
    return 1;
  }

  let releases;
  try {
    const data = await apiGetJson(serverBase + '/api/projects/' + projectId + '/releases', token);
    releases = (data && data.releases) || [];
  } catch (e) {
    process.stderr.write('uh-oh: failed to fetch releases: ' + errMsg(e) + '\n');
    return 1;
  }

  const releaseIdFor = (platform) => {
    const r = releases.find(
      (x) => x.version === parsed.version && x.build === parsed.build && x.platform === platform,
    );
    return r ? r.id : undefined;
  };
  let webReleaseId = webMaps.length > 0 ? releaseIdFor('web') : undefined;
  let nodeReleaseId = nodeMaps.length > 0 ? releaseIdFor('node') : undefined;

  let failed = 0;
  // Uploads usually run before the first crash event of a release, so a
  // missing row is the normal case: create it via the idempotent upsert and
  // proceed. Only an upsert FAILURE fails that platform's maps.
  if (webMaps.length > 0 && !webReleaseId) {
    try {
      webReleaseId = await upsertRelease(
        serverBase,
        token,
        projectId,
        parsed.version,
        parsed.build,
        'web',
      );
      process.stdout.write('uh-oh: created release ' + args.release + ' for platform web\n');
    } catch (e) {
      process.stderr.write(
        'uh-oh: could not create release ' + args.release + ' for platform web: ' + errMsg(e) + '\n',
      );
      failed += webMaps.length;
    }
  }
  if (nodeMaps.length > 0 && !nodeReleaseId) {
    try {
      nodeReleaseId = await upsertRelease(
        serverBase,
        token,
        projectId,
        parsed.version,
        parsed.build,
        'node',
      );
      process.stdout.write('uh-oh: created release ' + args.release + ' for platform node\n');
    } catch (e) {
      process.stderr.write(
        'uh-oh: could not create release ' +
          args.release +
          ' for platform node: ' +
          errMsg(e) +
          '\n',
      );
      failed += nodeMaps.length;
    }
  }

  const uploadable = [];
  if (webReleaseId) {
    for (const c of webMaps) {
      uploadable.push({
        platform: c.platform,
        absPath: c.absPath,
        bundlePath: c.bundlePath,
        releaseId: webReleaseId,
      });
    }
  }
  if (nodeReleaseId) {
    for (const c of nodeMaps) {
      uploadable.push({
        platform: c.platform,
        absPath: c.absPath,
        bundlePath: c.bundlePath,
        releaseId: nodeReleaseId,
      });
    }
  }

  let uploadedWeb = 0;
  let uploadedNode = 0;
  let skipped = 0;
  const uploadedWebPaths = [];

  for (let i = 0; i < uploadable.length; i++) {
    const item = uploadable[i];
    let size;
    try {
      size = statSync(item.absPath).size;
    } catch {
      process.stderr.write('uh-oh: cannot read ' + item.absPath + '\n');
      failed++;
      continue;
    }
    if (size > MAX_UPLOAD_BYTES) {
      process.stdout.write(
        'uh-oh: skipping ' + item.bundlePath + ' (' + mb(size) + ' MB exceeds 50 MB)\n',
      );
      skipped++;
      continue;
    }
    process.stdout.write(
      '[' + (i + 1) + '/' + uploadable.length + '] ' + item.platform + ' ' + item.bundlePath + '\n',
    );
    let ok = false;
    try {
      ok = await uploadOne(serverBase, token, item.releaseId, item);
    } catch (e) {
      process.stderr.write('uh-oh: upload error for ' + item.bundlePath + ': ' + errMsg(e) + '\n');
      ok = false;
    }
    if (!ok) {
      process.stderr.write('uh-oh: upload failed for ' + item.bundlePath + '\n');
      failed++;
      continue;
    }
    if (item.platform === 'web') {
      uploadedWeb++;
      uploadedWebPaths.push(item.absPath);
    } else {
      uploadedNode++;
    }
  }

  process.stdout.write(
    'uh-oh: uploaded ' +
      uploadedWeb +
      ' web + ' +
      uploadedNode +
      ' node maps (' +
      skipped +
      ' skipped)\n',
  );

  if (args.keepBrowserMaps) {
    process.stdout.write(
      'uh-oh: keeping browser source maps on disk (--keep-browser-maps)\n',
    );
  } else if (failed > 0) {
    process.stderr.write('uh-oh: not deleting browser source maps because some uploads failed\n');
  } else {
    let deleted = 0;
    for (const p of uploadedWebPaths) {
      try {
        unlinkSync(p);
        deleted++;
      } catch (e) {
        process.stderr.write('uh-oh: could not delete ' + p + ': ' + errMsg(e) + '\n');
      }
    }
    process.stdout.write('uh-oh: deleted ' + deleted + ' browser source map file(s)\n');
  }

  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((e) => {
    process.stderr.write('uh-oh: ' + errMsg(e) + '\n');
    process.exit(1);
  });
