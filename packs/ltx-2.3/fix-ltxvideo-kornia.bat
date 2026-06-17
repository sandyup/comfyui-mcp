@echo off
setlocal EnableExtensions DisableDelayedExpansion

title Fix LTXVideo Kornia Import Error

echo =====================================================
echo Fixing ComfyUI-LTXVideo Kornia compatibility issue
echo =====================================================
echo.

cd /d "%~dp0"

set "PYTHON=%CD%\python_embeded\python.exe"
set "LTX_FILE=%CD%\ComfyUI\custom_nodes\ComfyUI-LTXVideo\pyramid_blending.py"
set "PS_SCRIPT=%TEMP%\fix_ltxvideo_kornia.ps1"

if not exist "%PYTHON%" (
    echo [ERROR] Portable Python was not found:
    echo %PYTHON%
    echo.
    echo Put this BAT file inside your ComfyUI_windows_portable folder.
    echo.
    pause
    exit /b 1
)

if not exist "%LTX_FILE%" (
    echo [ERROR] ComfyUI-LTXVideo was not found:
    echo %LTX_FILE%
    echo.
    echo Make sure the ComfyUI-LTXVideo custom node is installed first.
    echo.
    pause
    exit /b 1
)

echo Found portable Python:
echo %PYTHON%
echo.
echo Found LTXVideo file:
echo %LTX_FILE%
echo.

if exist "%PS_SCRIPT%" del /f /q "%PS_SCRIPT%" >nul 2>&1

echo Creating PowerShell patch script...

>> "%PS_SCRIPT%" echo param([string]$FilePath)
>> "%PS_SCRIPT%" echo.
>> "%PS_SCRIPT%" echo $ErrorActionPreference = "Stop"
>> "%PS_SCRIPT%" echo.
>> "%PS_SCRIPT%" echo if (!(Test-Path -LiteralPath $FilePath)) {
>> "%PS_SCRIPT%" echo     throw "File not found: $FilePath"
>> "%PS_SCRIPT%" echo }
>> "%PS_SCRIPT%" echo.
>> "%PS_SCRIPT%" echo $text = [System.IO.File]::ReadAllText($FilePath)
>> "%PS_SCRIPT%" echo $original = $text
>> "%PS_SCRIPT%" echo.
>> "%PS_SCRIPT%" echo $backupPath = "$FilePath.bak_kornia_fix"
>> "%PS_SCRIPT%" echo if (!(Test-Path -LiteralPath $backupPath)) {
>> "%PS_SCRIPT%" echo     Copy-Item -LiteralPath $FilePath -Destination $backupPath -Force
>> "%PS_SCRIPT%" echo     Write-Host "[OK] Backup created: $backupPath"
>> "%PS_SCRIPT%" echo } else {
>> "%PS_SCRIPT%" echo     Write-Host "[OK] Backup already exists: $backupPath"
>> "%PS_SCRIPT%" echo }
>> "%PS_SCRIPT%" echo.
>> "%PS_SCRIPT%" echo $pattern = '(?ms)(from kornia\.geometry\.transform\.pyramid import \(\s*.*?)(^\s*pad,\s*$)(.*?^\s*\))'
>> "%PS_SCRIPT%" echo $text = [regex]::Replace($text, $pattern, '$1$3', 1)
>> "%PS_SCRIPT%" echo.
>> "%PS_SCRIPT%" echo if ($text -notmatch 'pad\s*=\s*F\.pad') {
>> "%PS_SCRIPT%" echo     $target = 'import torch.nn.functional as F'
>> "%PS_SCRIPT%" echo     if ($text.Contains($target)) {
>> "%PS_SCRIPT%" echo         $replacement = "import torch.nn.functional as F`r`n`r`n# Compatibility fix for Kornia 0.8.3+ where pad is no longer exported here`r`npad = F.pad"
>> "%PS_SCRIPT%" echo         $text = $text.Replace($target, $replacement)
>> "%PS_SCRIPT%" echo     } else {
>> "%PS_SCRIPT%" echo         throw "Could not find 'import torch.nn.functional as F' in pyramid_blending.py"
>> "%PS_SCRIPT%" echo     }
>> "%PS_SCRIPT%" echo }
>> "%PS_SCRIPT%" echo.
>> "%PS_SCRIPT%" echo if ($text -eq $original) {
>> "%PS_SCRIPT%" echo     Write-Host "[OK] File already appears to be patched."
>> "%PS_SCRIPT%" echo } else {
>> "%PS_SCRIPT%" echo     [System.IO.File]::WriteAllText($FilePath, $text, [System.Text.UTF8Encoding]::new($false))
>> "%PS_SCRIPT%" echo     Write-Host "[OK] LTXVideo Kornia compatibility patch applied."
>> "%PS_SCRIPT%" echo }
>> "%PS_SCRIPT%" echo.
>> "%PS_SCRIPT%" echo $patched = [System.IO.File]::ReadAllText($FilePath)
>> "%PS_SCRIPT%" echo.
>> "%PS_SCRIPT%" echo if ($patched -notmatch 'pad\s*=\s*F\.pad') {
>> "%PS_SCRIPT%" echo     throw "Patch check failed: pad = F.pad was not added."
>> "%PS_SCRIPT%" echo }
>> "%PS_SCRIPT%" echo.
>> "%PS_SCRIPT%" echo $importBlock = [regex]::Match($patched, '(?ms)from kornia\.geometry\.transform\.pyramid import \((.*?)\)')
>> "%PS_SCRIPT%" echo if ($importBlock.Success -and $importBlock.Groups[1].Value -match '(?m)^\s*pad,\s*$') {
>> "%PS_SCRIPT%" echo     throw "Patch check failed: broken Kornia pad import is still present."
>> "%PS_SCRIPT%" echo }
>> "%PS_SCRIPT%" echo.
>> "%PS_SCRIPT%" echo Write-Host "[OK] Patch verification passed."

echo Running patch...
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -FilePath "%LTX_FILE%"

if errorlevel 1 (
    echo.
    echo [ERROR] Failed to patch LTXVideo.
    echo.
    pause
    exit /b 1
)

del /f /q "%PS_SCRIPT%" >nul 2>&1

echo.
echo =====================================================
echo DONE
echo =====================================================
echo.
echo The LTXVideo Kornia import error should now be fixed.
echo Restart ComfyUI.
echo.
pause
exit /b 0