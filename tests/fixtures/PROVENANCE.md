# Fixture provenance

Every committed binary under `tests/fixtures/` is pinned by [`SHA256SUMS`](SHA256SUMS);
`tests/example-fixtures.test.ts` fails on a changed checksum, a missing file or
an unlisted one. The files are never regenerated in place: a new byte is a new
fixture, with a new checksum and a line in the release note.

Hostile archives are **not** committed. They are crafted in-test, byte by byte,
by the vendored raw builder (`tests/_fixtures/raw-zip-builder.ts`, used through
`tests/_zip-fixtures.ts`), so their shape is visible in the code that tests
them. The one exception is `examples/zip-slip.zip`, the frozen input of a
published example.

## `examples/` — the frozen inputs of the published examples

Written once by the builders of `tests/_zip-fixtures.ts` (the engine for the
benign archives, the raw builder for the hostile one) and committed on
2026-10-18 (commit `c1f772b`, the byte baseline taken before the 1.1.0 work).
They resolve the placeholder vocabulary of `examples/*.json`
(`<zip-base64>`, `<rich-zip-base64>`, …) for both the sample generator
(`scripts/helpers/io.ts`) and the suite (`tests/examples.test.ts`);
`tests/example-fixtures.test.ts` asserts that each one still equals what its
builder produces, so the two resolutions cannot drift apart.

| File | Placeholder | What it is |
|---|---|---|
| `basic.zip` | `<zip-base64>` | `basicZip()`: `README.md`, `src/index.js`, `docs/guide.md` (deflated), the directory `assets/` |
| `rich.zip` | `<rich-zip-base64>` | `richZip()`: archive and entry comments, a Unix mode 0755, a Unicode name, a private extra field, an empty file, a directory with attributes, a pinned date |
| `truncated.zip` | `<truncated-zip-base64>` | The first 60 bytes of `basic.zip` (no central directory, a cut local entry): the input of the forward-scanner examples |
| `zip-slip.zip` | `<hostile-zip-slip-base64>` | A raw-crafted entry named `../../evil.txt`: every extraction path must refuse it |
| `raw-deflate.bin` | `<raw-deflate-base64>` | `hello hello hello` as a raw DEFLATE stream (`node:zlib` `deflateRawSync`) for `inflate_raw` |
| `dump.bin` | — | 16 KiB of a fixed byte pattern: the sandbox file `incoming/dump.bin` the streamed-source and Zip64-streaming examples read |

## `interop/` — foreign provenance

Written by tools other than zipnative, so a defect cannot be baked into both a
fixture and its reading. Committed on 2026-09-07 (commit `b3cd196`); the exact
versions of the tools were not recorded at the time.

| File | Producer | What it exercises |
|---|---|---|
| `bsdtar-basic.zip` | libarchive `bsdtar` (`tar -a -cf`), Windows | A foreign writer's layout (its own extra fields and version-made-by); `canonicalize_zip` and `modify_zip` `canonical` read it |
| `powershell-compress-archive-basic.zip` | PowerShell `Compress-Archive` (.NET `System.IO.Compression`) | The .NET writer's layout, the most common ZIP producer on Windows hosts |
