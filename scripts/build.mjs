
// Orange Translate plugin build (owner: DS; M0 chain, extended in M1).
//
// Produces a deterministic XPI with the original four entry points plus the
// native API preferences fragment and the plugin icon. The
// lifecycle entry is compiled from src/zotero/lifecycle.ts as a browser/IIFE
// bundle (target firefox115, globalName OrangeTranslateLifecycle), which
// bundles the whole src/ module graph so bootstrap.js can read
// scope.OrangeTranslateLifecycle.createLifecycle.
//
// DS must not ship a stand-in lifecycle. The default source is the real module
// and a missing source is a hard, clear failure. Packaging tests pass
// --lifecycle <fixture> with an explicit --out <temp>; a fixture may never
// write the formal dist path. In M1 the M0 bundling rule is unchanged: the
// Product assets are listed explicitly in ENTRY_ORDER.
//
// esbuild runs with write:false so bundling never touches a shared on-disk
// intermediate, which keeps concurrent test runs independent.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import * as esbuild from 'esbuild';

var ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
var DEFAULT_LIFECYCLE = path.join(ROOT, 'src', 'zotero', 'lifecycle.ts');
var DEFAULT_OUT = path.join(ROOT, 'dist', 'orange-translate-0.3.5.xpi');

// --- Opt-in test package build (M2-REAL-0) -----------------------------------
//
// A test package is a separate, test-only XPI whose entries bundle EXISTING
// product sources into a driver plugin. It is built only when
// --test-package <name> is passed together with an explicit --out that resolves
// inside this worktree's .local directory. The default build path is untouched:
// with no --test-package the emitted artifact and its bytes are unchanged.
var LOCAL_ROOT = path.join(ROOT, '.local');

var TEST_PACKAGES = {
  'm2-real-0': {
    // Fixed entry order, independent of filesystem enumeration order.
    entryOrder: ['bootstrap.js', 'manifest.json'],
    bundles: {
      'bootstrap.js': {
        source: path.join(ROOT, 'docs', 'tasks', 'm2-real-0', 'driver', 'driver.ts'),
        globalName: 'OrangeM2Real0Driver',
        // The IIFE exposes the driver API under globalName; Zotero's plugin
        // loader calls install/startup/shutdown/uninstall as top-level scope
        // functions, so the emitted bundle needs a thin entry shim.
        pluginEntryShim: true,
      },
    },
    copies: {
      'manifest.json': path.join(ROOT, 'docs', 'tasks', 'm2-real-0', 'driver', 'manifest.json'),
    },
  },
};

/** Refuse any test-package output outside this worktree's .local directory. */
function assertLocalOut(out) {
  var local = path.resolve(LOCAL_ROOT);
  var target = path.resolve(out);
  var inside = target === local || target.startsWith(local + path.sep);
  if (!inside || target === path.resolve(DEFAULT_OUT)) {
    throw new Error('A test package may only be written under ' + LOCAL_ROOT
      + '; refusing output path ' + target);
  }
}

/** Top-level plugin entry shim that forwards to the bundled driver API. */
function pluginEntryShim(globalName) {
  return ['install', 'startup', 'shutdown', 'uninstall'].map(function (name) {
    return 'function ' + name + '(data, reason) { return ' + globalName + '.'
      + name + '(data, reason); }';
  }).join('\n');
}

// Fixed DOS date/time (1980-01-01 00:00:00) keeps rebuilds byte-identical.
var FIXED_DOS_TIME = 0;
var FIXED_DOS_DATE = 0x0021;

// Fixed entry order, independent of filesystem enumeration order.
var ENTRY_ORDER = ['bootstrap.js', 'lifecycle.js', 'manifest.json', 'prefs.js', 'api-prefs.xhtml', 'api-prefs.js', 'icon.png'];

var MAX_XPI_BYTES = 5 * 1024 * 1024;

function parseArgs(argv) {
  var opts = {
    lifecycle: DEFAULT_LIFECYCLE,
    out: DEFAULT_OUT,
    lifecycleGiven: false,
    outGiven: false,
    testPackage: null,
    testPackageGiven: false,
    quiet: false
  };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--lifecycle') {
      opts.lifecycle = path.resolve(argv[++i]);
      opts.lifecycleGiven = true;
    }
    else if (a === '--out') {
      opts.out = path.resolve(argv[++i]);
      opts.outGiven = true;
    }
    else if (a === '--test-package') {
      opts.testPackage = argv[++i];
      opts.testPackageGiven = true;
    }
    else if (a === '--quiet') { opts.quiet = true; }
    else { throw new Error('Unknown argument: ' + a); }
  }
  if (opts.lifecycleGiven && !opts.outGiven) {
    throw new Error(
      '--lifecycle requires an explicit --out. Test fixtures must write to a'
      + ' separate temporary location, never the formal dist artifact.'
    );
  }
  if (opts.testPackageGiven) {
    if (opts.lifecycleGiven) {
      throw new Error('--test-package cannot be combined with --lifecycle');
    }
    if (!opts.outGiven) {
      throw new Error('--test-package requires an explicit --out under ' + LOCAL_ROOT);
    }
    if (typeof opts.testPackage !== 'string' || opts.testPackage.length === 0
      || !Object.prototype.hasOwnProperty.call(TEST_PACKAGES, opts.testPackage)) {
      throw new Error('Unknown test package: ' + opts.testPackage
        + ' (known: ' + Object.keys(TEST_PACKAGES).join(', ') + ')');
    }
    assertLocalOut(opts.out);
  }
  return opts;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Minimal deterministic ZIP writer (deflate, no data descriptor, fixed times).
export function buildZip(entries) {
  var local = [];
  var central = [];
  var offset = 0;
  for (var i = 0; i < entries.length; i++) {
    var name = Buffer.from(entries[i].name, 'utf8');
    var data = entries[i].data;
    var comp = deflateRawSync(data, { level: 9 });
    var crc = crc32(data) >>> 0;

    var lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed to extract
    lh.writeUInt16LE(0, 6);           // general purpose flags
    lh.writeUInt16LE(8, 8);           // compression method: deflate
    lh.writeUInt16LE(FIXED_DOS_TIME, 10);
    lh.writeUInt16LE(FIXED_DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, comp);

    var cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed to extract
    cd.writeUInt16LE(0, 8);           // general purpose flags
    cd.writeUInt16LE(8, 10);          // compression method: deflate
    cd.writeUInt16LE(FIXED_DOS_TIME, 12);
    cd.writeUInt16LE(FIXED_DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);          // extra field length
    cd.writeUInt16LE(0, 32);          // file comment length
    cd.writeUInt16LE(0, 34);          // disk number start
    cd.writeUInt16LE(0, 36);          // internal attributes
    cd.writeUInt32LE(0, 38);          // external attributes
    cd.writeUInt32LE(offset, 42);     // relative offset of local header
    central.push(cd, name);

    offset += lh.length + name.length + comp.length;
  }

  var centralBuf = Buffer.concat(central);
  var eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                       // disk number
  eocd.writeUInt16LE(0, 6);                       // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);          // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);         // total entries
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);                      // comment length

  return Buffer.concat([Buffer.concat(local), centralBuf, eocd]);
}

async function compileBundle(sourcePath, globalName, missingMessage, footer) {
  if (!existsSync(sourcePath)) {
    throw new Error(missingMessage.replace('{source}', sourcePath));
  }
  var options = {
    entryPoints: [sourcePath],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: globalName,
    target: 'firefox115',
    platform: 'browser',
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
  };
  if (footer) {
    options.footer = { js: footer };
  }
  var result = await esbuild.build(options);
  if (!result.outputFiles || result.outputFiles.length !== 1) {
    throw new Error('esbuild returned ' + (result.outputFiles ? result.outputFiles.length : 0)
      + ' output files; expected exactly 1');
  }
  return Buffer.from(result.outputFiles[0].contents);
}

async function compileLifecycle(sourcePath) {
  return compileBundle(
    sourcePath,
    'OrangeTranslateLifecycle',
    'Missing lifecycle source: {source}\n'
      + 'The formal M0 build requires the KIMI-M0-LIFECYCLE module. Build is'
      + ' intentionally blocked until that file exists. For packaging-only'
      + ' tests use: node scripts/build.mjs --lifecycle <fixture> --out <tmp>.',
    null
  );
}

export async function buildArtifact(opts) {
  var out = opts.out || DEFAULT_OUT;
  var source = opts.lifecycle || DEFAULT_LIFECYCLE;
  if (source !== DEFAULT_LIFECYCLE && out === DEFAULT_OUT) {
    throw new Error('Refusing to write a fixture lifecycle to the formal dist artifact.');
  }

  if (opts.testPackage) {
    return buildTestPackage(opts.testPackage, out);
  }

  var lifecycle = await compileLifecycle(source);
  var manifest = await readFile(path.join(ROOT, 'manifest.json'));
  var bootstrap = await readFile(path.join(ROOT, 'bootstrap.js'));
  var prefs = await readFile(path.join(ROOT, 'prefs.js'));
  var apiPrefs = await readFile(path.join(ROOT, 'api-prefs.xhtml'));
  var apiPrefsScript = await readFile(path.join(ROOT, 'api-prefs.js'));
  var icon = await readFile(path.join(ROOT, 'icon.png'));

  var byName = {
    'bootstrap.js': bootstrap,
    'lifecycle.js': lifecycle,
    'manifest.json': manifest,
    'prefs.js': prefs,
    'api-prefs.xhtml': apiPrefs,
    'api-prefs.js': apiPrefsScript,
    'icon.png': icon,
  };
  var entries = ENTRY_ORDER.map(function (name) {
    return { name: name, data: byName[name] };
  });

 var zip = buildZip(entries);
  // Enforce the size contract before touching the output path, so an
  // oversize build never leaves a non-conformant artifact on disk.
  if (zip.length > MAX_XPI_BYTES) {
    throw new Error('XPI exceeds 5 MiB limit: ' + zip.length + ' bytes');
  }
 await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, zip);

  return {
    out: out,
    lifecycleSource: source,
    xpiBytes: zip.length,
    xpiSha256: sha256(zip),
    entrySha256: ENTRY_ORDER.map(function (name) {
      return { name: name, bytes: byName[name].length, sha256: sha256(byName[name]) };
    }),
  };
}

/**
 * Build an opt-in, test-only package. Every output must sit under this
 * worktree's .local directory; the formal dist artifact and the frozen M0 entry
 * set are never touched. Only existing product sources are bundled.
 */
async function buildTestPackage(name, out) {
  var spec = TEST_PACKAGES[name];
  assertLocalOut(out);
  var byName = {};
  for (var bundleName in spec.bundles) {
    var bundleSpec = spec.bundles[bundleName];
    var footer = bundleSpec.pluginEntryShim ? pluginEntryShim(bundleSpec.globalName) : null;
    byName[bundleName] = await compileBundle(
      bundleSpec.source,
      bundleSpec.globalName,
      'Missing test-package source: {source}',
      footer
    );
  }
  for (var copyName in spec.copies) {
    byName[copyName] = await readFile(spec.copies[copyName]);
  }
  var entries = spec.entryOrder.map(function (entryName) {
    return { name: entryName, data: byName[entryName] };
  });
  var zip = buildZip(entries);
  if (zip.length > MAX_XPI_BYTES) {
    throw new Error('Test package exceeds 5 MiB limit: ' + zip.length + ' bytes');
  }
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, zip);
  return {
    out: out,
    testPackage: name,
    xpiBytes: zip.length,
    xpiSha256: sha256(zip),
    entrySha256: spec.entryOrder.map(function (entryName) {
      return { name: entryName, bytes: byName[entryName].length, sha256: sha256(byName[entryName]) };
    }),
  };
}

async function main() {
  var opts = parseArgs(process.argv.slice(2));
  var result = opts.testPackage
    ? await buildTestPackage(opts.testPackage, opts.out)
    : await buildArtifact(opts);
 if (!opts.quiet) {
    console.log(JSON.stringify(result, null, 2));
  }
}

var invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(function (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exitCode = 1;
  });
}
