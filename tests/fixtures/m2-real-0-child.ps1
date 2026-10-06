# M2-REAL-0 harmless local child fixture (TEST-ONLY).
#
# The smallest auditable child that can exercise the adapter against a real
# host. It deliberately does NOT:
#   - open a network socket or call any provider/API,
#   - read or write any user file outside its own job directory,
#   - touch the Zotero database, Library, attachments or profile,
#   - load a Runtime, BabelDOC, pdf2zh or any translation engine,
#   - contain a real credential. The only secret-shaped string is a fake
#     sentinel supplied by the test driver, and it is never printed.
#
# It only: reads its request JSON, emits bounded acknowledged stdout/stderr
# markers, optionally reads one length-prefixed fake stdin frame, writes a
# structurally valid synthetic PDF plus a schema-v1 result, and exits 0 or
# non-zero according to the requested case.
param(
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$marker = '[M2REAL0-CHILD]'
$nl = [string][char]10
$ff = [char]0xFF

function Emit([string]$Text) {
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
}

function EmitErr([string]$Text) {
    [Console]::Error.WriteLine($Text)
    [Console]::Error.Flush()
}

# Read one 4-byte big-endian length frame from stdin. Returns $null at EOF.
# The payload is parsed only to confirm provider/job correlation; its contents
# are never echoed.
function Read-StdinFrame {
    $stdin = [Console]::OpenStandardInput()
    $header = New-Object byte[] 4
    $read = 0
    while ($read -lt 4) {
        $n = $stdin.Read($header, $read, 4 - $read)
        if ($n -le 0) { return $null }
        $read += $n
    }
    $length = ([int]$header[0] * 16777216) + ([int]$header[1] * 65536) + ([int]$header[2] * 256) + [int]$header[3]
    if ($length -lt 0 -or $length -gt 65536) {
        EmitErr "$marker stdin-frame-rejected length=$length"
        return $null
    }
    $payload = New-Object byte[] $length
    $got = 0
    while ($got -lt $length) {
        $n = $stdin.Read($payload, $got, $length - $got)
        if ($n -le 0) { return $null }
        $got += $n
    }
    return [System.Text.Encoding]::UTF8.GetString($payload) | ConvertFrom-Json
}

# Minimal synthetic PDF (catalog -> pages -> page, xref, trailer, startxref).
function New-SyntheticPdf([int]$XrefOffset) {
    $head = "%PDF-1.7" + $nl + "%" + $ff + $ff + $ff + $ff + $nl
    $o1 = "1 0 obj" + $nl + "<< /Type /Catalog /Pages 2 0 R >>" + $nl + "endobj" + $nl
    $o2 = "2 0 obj" + $nl + "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" + $nl + "endobj" + $nl
    $o3 = "3 0 obj" + $nl + "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>" + $nl + "endobj" + $nl
    $ref1 = $head + $o1
    $ref2 = $ref1 + $o2
    $ref3 = $ref2 + $o3
    $offsets = @($ref1.Length, $ref2.Length, $ref3.Length)
    $xref = "xref" + $nl + "0 4" + $nl + "0000000000 65535 f " + $nl
    foreach ($offset in $offsets) {
        $xref += ('{0:D10} 00000 n ' -f $offset) + $nl
    }
    $trailer = "trailer" + $nl + "<< /Size 4 /Root 1 0 R >>" + $nl + "startxref" + $nl + $XrefOffset + $nl + "%%EOF" + $nl
    return $ref3 + $xref + $trailer
}

function Write-SyntheticPdf([string]$Target) {
    $placeholder = New-SyntheticPdf 0
    $xrefOffset = $placeholder.IndexOf('xref')
    [System.IO.File]::WriteAllText($Target, (New-SyntheticPdf $xrefOffset), [System.Text.Encoding]::Latin1)
}

function Write-Result([string]$Status, [hashtable]$Outputs) {
    $result = [ordered]@{
        schemaVersion = 1
        jobId = [string]$request.jobId
        status = $Status
        outputs = $Outputs
        runtime = [ordered]@{ version = 'm2-real-0-child/1.0.0' }
    }
    $json = $result | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($ResultPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
# The bridge forwards only provider.id/model; the test case travels in
# provider.model, the one free-form field the frozen request serializer keeps.
$case = [string]$request.provider.model
$outputDir = [string]$request.outputDir

Emit "$marker start case=$case"

$wantFrame = $true
switch ($case) {
    'sleep'       { $wantFrame = $false }
    'exitnonzero' { $wantFrame = $false }
    default       { $wantFrame = $true }
}

if ($case -eq 'readerafter') {
    # Prove the bridge's stdout reader is live BEFORE it writes any stdin frame.
    Emit "$marker reader-live-probe"
    Start-Sleep -Milliseconds 400
}

if ($case -eq 'pressure') {
    # Bounded high-volume output on both pipes before the stdin frame is read.
    $line = ('{0} pressure-line ' -f $marker) + ('x' * 900)
    for ($i = 0; $i -lt 96; $i++) { Emit $line }
    for ($i = 0; $i -lt 96; $i++) { EmitErr $line }
}

if ($case -eq 'cancelwait' -or $case -eq 'hold') {
    Emit "$marker waiting case=$case"
    if ($wantFrame) {
        # Block until EOF; the bridge never sends a frame in these cases.
        [void](Read-StdinFrame)
    }
    Start-Sleep -Seconds 300
    Emit "$marker unexpected-completion case=$case"
    exit 0
}

if ($case -eq 'sleep') {
    Emit "$marker sleeping"
    Start-Sleep -Seconds 300
    exit 0
}

if ($wantFrame) {
    $frame = Read-StdinFrame
    if ($null -eq $frame) {
        Emit "$marker stdin-eof"
    }
    else {
        $jobMatches = ([string]$frame.jobId -eq [string]$request.jobId)
        $keyLength = 0
        if ($null -ne $frame.apiKey) { $keyLength = ([string]$frame.apiKey).Length }
        Emit "$marker stdin-ack provider=$($frame.providerId) jobMatch=$jobMatches keyLength=$keyLength"
    }
}

if ($case -eq 'exitnonzero') {
    Write-Result 'failed' @{}
    EmitErr "$marker failing-on-purpose"
    exit 3
}

$outputs = @{}
foreach ($name in @('out.zh.dual.pdf', 'out.zh.mono.pdf')) {
    $target = Join-Path $outputDir $name
    Write-SyntheticPdf $target
    $key = if ($name -like '*dual*') { 'dualPdf' } else { 'monoPdf' }
    $outputs[$key] = $target
}

Write-Result 'completed' $outputs
Emit "$marker stdout-complete case=$case"
EmitErr "$marker stderr-marker case=$case"
exit 0
