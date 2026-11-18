# Parses every .ps1 in the repo and fails if any has a syntax error.
# CI runs it under both Windows PowerShell 5.1 and PowerShell 7, because the
# installers must work in the stock Windows shell.
param([string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path)

$files = Get-ChildItem -Path $Root -Recurse -Filter *.ps1 -File |
    Where-Object { $_.FullName -notmatch '[\\/]node_modules[\\/]' }
$failed = 0
foreach ($file in $files) {
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$errors)
    foreach ($e in $errors) {
        $failed++
        Write-Output "::error file=$($file.FullName),line=$($e.Extent.StartLineNumber)::$($e.Message)"
    }
}
Write-Output "PowerShell $($PSVersionTable.PSVersion): parsed $($files.Count) files, $failed errors"
if ($failed) { exit 1 }
