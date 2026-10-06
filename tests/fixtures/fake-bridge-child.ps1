# M2C synthetic PowerShell bridge child (owner: M2C-POWERSHELL-BRIDGE / DS).
#
# TEST-ONLY. This script is never executed by the test suite: the M2C tests use
# an injected fake Subprocess host, and this file documents the non-interactive
# contract the bridge expects and is a fixture for any future host smoke test.
#
# It deliberately does NOT call the reference launcher, download/install a
# Runtime, read a key, call a provider/API, or touch Zotero data. It only reads
# its request file, writes a synthetic structurally-valid PDF, and emits a
# schema-v1 result.
param(
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'

# Read the request the bridge wrote. The request contains no credential.
$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$outputDir = [string]$request.outputDir

# Minimal synthetic PDF: catalog -> pages -> page, xref, trailer, startxref.
function New-SyntheticPdf([int]$XrefOffset) {
    $header = "%PDF-1.7`n%`$([char]0xFF)`$([char]0xFF)`$([char]0xFF)`$([char]0xFF)`n"
    $o1 = "1 0 obj`n<< /Type /Catalog /Pages 2 0 R >>`nendobj`n"
    $o2 = "2 0 obj`n<< /Type /Pages /Kids [3 0 R] /Count 1 >>`nendobj`n"
    $o3 = "3 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>`nendobj`n"
    $offsets = @(0, 0, 0)
    $ref1 = $header + $o1
    $offsets[0] = $ref1.Length
    $ref2 = $ref1 + $o2
    $offsets[1] = $ref2.Length
    $ref3 = $ref2 + $o3
    $offsets[2] = $ref3.Length
    $body = $ref3
    $xref = "xref`n0 4`n0000000000 65535 f `n"
    foreach ($offset in $offsets) {
        $xref += ('{0:D10} 00000 n ' -f $offset) + "`n"
    }
    $trailer = "trailer`n<< /Size 4 /Root 1 0 R >>`nstartxref`n$XrefOffset`n%%EOF`n"
    return $body + $xref + $trailer
}

$outputs = @{}
$wantDual = ($request.outputMode -eq 'dual' -or $request.outputMode -eq 'both')
$wantMono = ($request.outputMode -eq 'mono' -or $request.outputMode -eq 'both')

foreach ($pair in @(@($wantDual, 'out.zh.dual.pdf'), @($wantMono, 'out.zh.mono.pdf'))) {
    if (-not $pair[0]) { continue }
    $target = Join-Path $outputDir $pair[1]
    $placeholder = New-SyntheticPdf 0
    # Compute the real xref offset = length before the 'xref' keyword.
    $xrefOffset = $placeholder.IndexOf('xref')
    [System.IO.File]::WriteAllText($target, (New-SyntheticPdf $xrefOffset), [System.Text.Encoding]::Latin1)
    $key = if ($pair[1] -like '*dual*') { 'dualPdf' } else { 'monoPdf' }
    $outputs[$key] = $target
}

$result = [ordered]@{
    schemaVersion = 1
    jobId = [string]$request.jobId
    status = 'completed'
    outputs = $outputs
    runtime = [ordered]@{ version = 'synthetic-child-1.0.0' }
}
[System.IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Depth 6), [System.Text.Encoding]::UTF8)
exit 0
