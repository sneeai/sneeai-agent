[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$AgentVersion,
    [Parameter(Mandatory = $true)][string]$PayloadDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$CertificateThumbprint = $env:SNEEAI_WINDOWS_SIGNING_THUMBPRINT,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [switch]$AllowUnsigned
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require-Command([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { throw "Required build tool is missing: $Name" }
    return $command.Source
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$payload = (Resolve-Path -LiteralPath $PayloadDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $payload 'sneeai-agent.exe') -PathType Leaf)) {
    throw 'Payload must contain sneeai-agent.exe at its root.'
}
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null

$inno = Require-Command 'ISCC.exe'
$innoVersion = (& $inno /?).Trim()
if ($innoVersion -notmatch 'Inno Setup 6') { throw 'Inno Setup 6 is required.' }
$compiler = Require-Command 'cl.exe'

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("sneeai-agent-installer-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $stagedPayload = Join-Path $stage 'payload'
    Copy-Item -LiteralPath $payload -Destination $stagedPayload -Recurse
    $launcher = Join-Path $stage 'sneeai-agent-launcher.exe'
    & $compiler /nologo /O2 /W4 /DUNICODE /D_UNICODE /MT (Join-Path $scriptDirectory 'launcher.c') /Fe:$launcher /link /SUBSYSTEM:WINDOWS shell32.lib
    if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit code $LASTEXITCODE" }

    $signed = -not [string]::IsNullOrWhiteSpace($CertificateThumbprint)
    if (-not $signed -and -not $AllowUnsigned) {
        throw 'A signing certificate thumbprint is required. Use -AllowUnsigned only for test installer builds.'
    }
    if ($signed) {
        $signTool = Require-Command 'signtool.exe'
        foreach ($file in @((Join-Path $stagedPayload 'sneeai-agent.exe'), $launcher)) {
            & $signTool sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $file
            if ($LASTEXITCODE -ne 0) { throw "Signing failed for $file" }
        }
    }

    $artifactName = "sneeai-agent-$AgentVersion-windows-x64.exe"
    $artifact = Join-Path $output $artifactName
    & $inno `
        "/DAgentVersion=$AgentVersion" `
        "/DPayloadDirectory=$stagedPayload" `
        "/DLauncherPath=$launcher" `
        "/DOutputDirectory=$output" `
        (Join-Path $scriptDirectory 'SneeAIAgent.iss')
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup build failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { throw 'Inno Setup did not create the expected installer.' }
    if ($signed) {
        & $signTool sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $artifact
        if ($LASTEXITCODE -ne 0) { throw 'Installer signing failed.' }
        if ((Get-AuthenticodeSignature -LiteralPath $artifact).Status -ne 'Valid') { throw 'Installer signature validation failed.' }
    }

    $digest = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$artifact.sha256" -Encoding ascii -NoNewline -Value "$digest  $artifactName`n"
    [ordered]@{
        schemaVersion = 1
        target = 'windows-x64'
        agentVersion = $AgentVersion
        artifact = $artifactName
        sha256 = $digest
        status = if ($signed) { 'built_signed_unverified' } else { 'built_unsigned_local_test' }
        signature = if ($signed) { 'performed_and_locally_verified' } else { 'not_performed' }
        publishable = $false
        testPublishable = -not $signed
        remainingGate = 'Clean Windows 11 lifecycle and release-channel verification are required.'
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath "$artifact.build.json" -Encoding utf8
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
