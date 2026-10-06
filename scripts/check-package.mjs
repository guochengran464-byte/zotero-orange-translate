
// Orange Translate M0 package check (owner: DS-M0-BUILD).
//
// Verifies a built XPI against the frozen M0 contract and against ZIP
// structural integrity: exact entry set with no duplicates, <= 5 MiB, manifest
// identity/isolation fields, no forbidden payloads, plus per-entry CRC and
// uncompressed-length agreement, and local-header / central-directory
// agreement. A corrupted archive must not pass.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var DEFAULT_XPI = path.join(ROOT, 'dist', 'orange-translate-1.0.0.xpi');
var MAX_XPI_BYTES = 5 * 1024 * 1024;
var REQUIRED_ENTRIES = ['manifest.json', 'bootstrap.js', 'prefs.js', 'lifecycle.js', 'api-prefs.xhtml', 'api-prefs.js', 'icon.png'];
var FORBIDDEN_PATTERNS = [
  /\.map$/i,
  /(^|\/)node_modules\//i,
  /(^|\/)src\//i,
  /(^|\/)tests?\//i,
  /(^|\/)reference\//i,
  /(^|\/)scripts\//i,
  /\.ts$/i,
  /\.tsx$/i
];

function parseArgs(argv) {
  var out = DEFAULT_XPI;
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--xpi') { out = path.resolve(argv[++i]); }
    else { throw new Error('Unknown argument: ' + argv[i]); }
  }
  return out;
}

// Reads the central directory and decompresses each entry, recording both
// central-directory and local-header facts so callers can cross-check them.
export function readZipEntries(buf) {
  var eocd = -1;
  for (var i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) { throw new Error('Not a ZIP file: no end-of-central-directory record'); }

  var diskEntries = buf.readUInt16LE(eocd + 8);
  var totalEntries = buf.readUInt16LE(eocd + 10);
  if (diskEntries !== totalEntries) {
    throw new Error('Multi-disk archives are not supported (' + diskEntries + '/' + totalEntries + ')');
  }
  var cdSize = buf.readUInt32LE(eocd + 12);
  var cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > eocd) {
    throw new Error('Central directory overruns the end-of-central-directory record');
  }

  var entries = [];
  var p = cdOffset;
  for (var n = 0; n < totalEntries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('Bad central directory header at offset ' + p);
    }
    var cdMethod = buf.readUInt16LE(p + 10);
    var cdTime = buf.readUInt16LE(p + 12);
    var cdDate = buf.readUInt16LE(p + 14);
    var cdCrc = buf.readUInt32LE(p + 16);
    var cdCompSize = buf.readUInt32LE(p + 20);
    var cdSize = buf.readUInt32LE(p + 24);
    var nameLen = buf.readUInt16LE(p + 28);
    var extraLen = buf.readUInt16LE(p + 30);
    var commentLen = buf.readUInt16LE(p + 32);
    var localOffset = buf.readUInt32LE(p + 42);
    var name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Bad local header for ' + name);
    }
    var lhMethod = buf.readUInt16LE(localOffset + 8);
    var lhTime = buf.readUInt16LE(localOffset + 10);
    var lhDate = buf.readUInt16LE(localOffset + 12);
    var lhCrc = buf.readUInt32LE(localOffset + 14);
    var lhCompSize = buf.readUInt32LE(localOffset + 18);
    var lhSize = buf.readUInt32LE(localOffset + 22);
    var lhNameLen = buf.readUInt16LE(localOffset + 26);
    var lhExtraLen = buf.readUInt16LE(localOffset + 28);
    var lhName = buf.toString('utf8', localOffset + 30, localOffset + 30 + lhNameLen);

    var dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    if (dataStart + cdCompSize > buf.length) {
      throw new Error('Entry data overruns the archive for ' + name);
    }
    var raw = buf.subarray(dataStart, dataStart + cdCompSize);
    var data = cdMethod === 0 ? raw : inflateRawSync(raw);

    entries.push({
      name: name,
      method: cdMethod,
      dosTime: cdTime,
      dosDate: cdDate,
      compSize: cdCompSize,
      size: cdSize,
      crc: cdCrc,
      data: data,
      computedCrc: crc32(data) >>> 0,
      local: {
        name: lhName,
        method: lhMethod,
        dosTime: lhTime,
        dosDate: lhDate,
        crc: lhCrc,
        compSize: lhCompSize,
        size: lhSize
      }
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function renderHooksRegex(hook) {
  // Matches "function startup(" allowing any whitespace before the paren.
  return new RegExp('function\\s+' + hook + '\\s*\\(');
}

export function checkArtifact(buf) {
  var errors = [];
  var entries;
  try {
    entries = readZipEntries(buf);
  }
  catch (e) {
    return { ok: false, errors: ['ZIP structure error: ' + e.message], bytes: buf.length, entries: [] };
  }
  var names = entries.map(function (e) { return e.name; });

  if (buf.length > MAX_XPI_BYTES) {
    errors.push('XPI is ' + buf.length + ' bytes, over the 5 MiB limit');
  }

  var seen = Object.create(null);
  for (var d = 0; d < names.length; d++) {
    if (seen[names[d]]) { errors.push('Duplicate entry: ' + names[d]); }
    seen[names[d]] = true;
  }

  for (var i = 0; i < REQUIRED_ENTRIES.length; i++) {
    if (names.indexOf(REQUIRED_ENTRIES[i]) === -1) {
      errors.push('Missing required entry: ' + REQUIRED_ENTRIES[i]);
    }
  }

  for (var j = 0; j < entries.length; j++) {
    var e = entries[j];
    if (REQUIRED_ENTRIES.indexOf(e.name) === -1) {
      errors.push('Unexpected entry: ' + e.name);
    }
    for (var k = 0; k < FORBIDDEN_PATTERNS.length; k++) {
      if (FORBIDDEN_PATTERNS[k].test(e.name)) {
        errors.push('Forbidden payload entry: ' + e.name);
      }
    }
    // Structural integrity: CRC, declared uncompressed size, and local vs
    // central agreement. A tampered or truncated archive fails here.
    if (e.computedCrc !== e.crc) {
      errors.push('CRC mismatch for ' + e.name);
    }
    if (e.data.length !== e.size) {
      errors.push('Uncompressed size mismatch for ' + e.name);
    }
    if (e.local.name !== e.name) {
      errors.push('Local header name mismatch for ' + e.name);
    }
    if (e.local.method !== e.method) {
      errors.push('Compression method mismatch for ' + e.name);
    }
    if (e.local.crc !== e.crc) {
      errors.push('Local header CRC mismatch for ' + e.name);
    }
    if (e.local.compSize !== e.compSize) {
      errors.push('Local header compressed size mismatch for ' + e.name);
    }
    if (e.local.size !== e.size) {
      errors.push('Local header size mismatch for ' + e.name);
    }
    if (e.local.dosDate !== e.dosDate || e.local.dosTime !== e.dosTime) {
      errors.push('Timestamp mismatch between local header and central directory for ' + e.name);
    }
  }

  var raw = null;
  for (var m = 0; m < entries.length; m++) {
    if (entries[m].name === 'manifest.json') { raw = entries[m].data; }
  }
 var manifest = null;
 if (raw) {
   try { manifest = JSON.parse(raw.toString('utf8')); }
   catch (e2) { errors.push('manifest.json is not valid JSON: ' + e2.message); }
 }
  // Falsy JSON such as null, false, 0 or "" must not silently skip every
  // manifest assertion, so require a real non-null, non-array object.
  var manifestOk = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest);
  if (!raw) {
    // Missing manifest.json is already reported as a missing required entry.
  }
  else if (!manifestOk) {
    errors.push('manifest.json must be a JSON object, got ' + JSON.stringify(manifest));
  }
  if (manifestOk) {
    if (manifest.manifest_version !== 2) { errors.push('manifest_version must be 2'); }
    if (manifest.version !== '1.0.0') { errors.push('version must be 1.0.0'); }
    if (manifest.name !== 'Orange Translate') {
      errors.push('name must be "Orange Translate"');
    }
    if (Object.prototype.hasOwnProperty.call(manifest, 'update_url')) {
      errors.push('manifest must not declare a top-level update_url');
    }
    if (Object.prototype.hasOwnProperty.call(manifest, 'homepage_url')) {
      errors.push('manifest must not declare homepage_url in M0');
    }
    if (Object.prototype.hasOwnProperty.call(manifest, 'author')) {
      errors.push('manifest must not declare an author in M0');
    }
    var zotero = manifest.applications && manifest.applications.zotero;
    if (!zotero) { errors.push('manifest.applications.zotero is required'); }
    else {
      if (zotero.id !== 'orange-translate-dev@local.invalid') {
        errors.push('applications.zotero.id must be orange-translate-dev@local.invalid');
      }
      if (zotero.strict_min_version !== '10.0') { errors.push('strict_min_version must be 10.0'); }
      if (zotero.strict_max_version !== '10.*') { errors.push('strict_max_version must be 10.*'); }
    if (Object.prototype.hasOwnProperty.call(zotero, 'update_url')) {
      if (zotero.update_url !== 'https://local.invalid/updates.json') {
        errors.push('applications.zotero.update_url must be the dev placeholder https://local.invalid/updates.json');
      }
      }
    }
  }

  var bootstrap = null;
  for (var q = 0; q < entries.length; q++) {
    if (entries[q].name === 'bootstrap.js') { bootstrap = entries[q].data.toString('utf8'); }
  }
  if (bootstrap !== null) {
    var hooks = ['install', 'startup', 'shutdown', 'uninstall'];
    for (var h = 0; h < hooks.length; h++) {
      if (!renderHooksRegex(hooks[h]).test(bootstrap)) {
        errors.push('bootstrap.js is missing ' + hooks[h] + '()');
      }
    }
    if (!/loadSubScriptWithOptions/.test(bootstrap)) {
      errors.push('bootstrap.js must load lifecycle.js via scriptloader');
    }
  }

  return {
    ok: errors.length === 0,
    errors: errors,
    bytes: buf.length,
    entries: entries.map(function (e) {
      return { name: e.name, bytes: e.size, method: e.method, dosDate: e.dosDate, dosTime: e.dosTime };
    })
  };
}

async function main() {
  var xpi = parseArgs(process.argv.slice(2));
  var buf = await readFile(xpi);
  var result = checkArtifact(buf);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) { process.exitCode = 1; }
}

var invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(function (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exitCode = 1;
  });
}
