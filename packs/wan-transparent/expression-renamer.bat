@echo off
setlocal enabledelayedexpansion

echo Renaming files in:
echo   %cd%
echo.

for %%F in (*.*) do (
    set "name=%%~nF"
    set "ext=%%~xF"

    rem take everything before the first underscore
    for /f "tokens=1 delims=_" %%A in ("!name!") do set "base=%%A"

    echo "%%F" ^> "!base!!ext!"
    ren "%%F" "!base!!ext!"
)

echo.
echo Done.
pause
