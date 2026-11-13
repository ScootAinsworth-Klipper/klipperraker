param([switch]$Bump)

$ErrorActionPreference = "Stop"

$appDir = "C:\Gemini\KlipperController-App"
$buildTools = "C:\Users\scoot\AppData\Local\Android\Sdk\build-tools\35.0.0"
$platform = "C:\Users\scoot\AppData\Local\Android\Sdk\platforms\android-34"

$aapt2 = "$buildTools\aapt2.exe"
$d8 = "$buildTools\d8.bat"
$zipalign = "$buildTools\zipalign.exe"
$apksigner = "$buildTools\apksigner.bat"
$androidJar = "$platform\android.jar"

Set-Location $appDir

$utf8NoBom = New-Object System.Text.UTF8Encoding $false

# Read and optionally bump version in AndroidManifest.xml, then sync fallback strings in assets
$manifestPath = "$appDir\AndroidManifest.xml"
$manifestText = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
$vCodeMatch = [regex]::Match($manifestText, 'android:versionCode="(\d+)"')
$vNameMatch = [regex]::Match($manifestText, 'android:versionName="([^"]+)"')
if (-not $vCodeMatch.Success -or -not $vNameMatch.Success) {
    throw "Could not parse versionCode/versionName from AndroidManifest.xml"
}
$vCode = [int]$vCodeMatch.Groups[1].Value
$vName = $vNameMatch.Groups[1].Value

if ($Bump) {
    $vCode++
    $parts = $vName.Split('.')
    $parts[$parts.Length - 1] = ([int]$parts[$parts.Length - 1] + 1).ToString()
    $vName = ($parts -join '.')
    $manifestText = [regex]::Replace($manifestText, 'android:versionCode="\d+"', "android:versionCode=`"$vCode`"")
    $manifestText = [regex]::Replace($manifestText, 'android:versionName="[^"]+"', "android:versionName=`"$vName`"")
    [System.IO.File]::WriteAllText($manifestPath, $manifestText, $utf8NoBom)
    Write-Host "Bumped version to v$vName (Build $vCode)"
}

$indexPath = "$appDir\assets\index.html"
$indexText = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)
$indexUpdated = [regex]::Replace($indexText, '(<div[^>]*id="lblCurrentAppVersion"[^>]*>)Version: [^<]+(</div>)', "`${1}Version: $vName (Build $vCode)`${2}")
if ($indexUpdated -ne $indexText) { [System.IO.File]::WriteAllText($indexPath, $indexUpdated, $utf8NoBom) }

$appJsPath = "$appDir\assets\app.js"
$appJsText = [System.IO.File]::ReadAllText($appJsPath, [System.Text.Encoding]::UTF8)
$appJsUpdated = [regex]::Replace($appJsText, 'let currentAppVersionName = "[^"]+";', "let currentAppVersionName = `"$vName`";")
$appJsUpdated = [regex]::Replace($appJsUpdated, 'let currentAppVersionCode = \d+;', "let currentAppVersionCode = $vCode;")
if ($appJsUpdated -ne $appJsText) { [System.IO.File]::WriteAllText($appJsPath, $appJsUpdated, $utf8NoBom) }

Write-Host "Building Klipperraker Pro v$vName (Build $vCode)..."

if (Test-Path "$appDir\build") { Remove-Item -Recurse -Force "$appDir\build" }
New-Item -ItemType Directory -Force -Path "$appDir\build\gen", "$appDir\build\obj" | Out-Null

Write-Host "Step 1: Compiling resources..."
& $aapt2 compile --dir "$appDir\res" -o "$appDir\build\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "Step 2: Linking resources & assets..."
& $aapt2 link -I $androidJar "$appDir\build\res.zip" -A "$appDir\assets" --manifest "$appDir\AndroidManifest.xml" --java "$appDir\build\gen" -o "$appDir\build\app-unaligned.apk" --auto-add-overlay
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "Step 3: Compiling Java sources..."
$javaFiles = @(
    "$appDir\build\gen\com\gemini\klipperraker\R.java",
    "$appDir\src\com\gemini\klipperraker\ApkProvider.java",
    "$appDir\src\com\gemini\klipperraker\LocalBridgeServer.java",
    "$appDir\src\com\gemini\klipperraker\MainActivity.java",
    "$appDir\src\com\gemini\klipperraker\PrintMonitorService.java"
)
& javac -source 8 -target 8 -cp $androidJar -d "$appDir\build\obj" $javaFiles
if ($LASTEXITCODE -ne 0) { throw "javac compilation failed" }

Write-Host "Step 4: Converting classes to DEX..."
$classFiles = Get-ChildItem -Path "$appDir\build\obj" -Recurse -Filter "*.class" | ForEach-Object { $_.FullName }
& $d8 --output "$appDir\build" $classFiles
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "Step 5: Adding DEX to APK..."
Set-Location "$appDir\build"
& jar -uf "$appDir\build\app-unaligned.apk" classes.dex
if ($LASTEXITCODE -ne 0) { throw "jar uf failed" }
Set-Location $appDir

Write-Host "Step 6: Aligning APK..."
& $zipalign -f -v -p 4 "$appDir\build\app-unaligned.apk" "$appDir\Klipperraker-Pro.apk" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "Step 7: Signing APK..."
& $apksigner sign --ks "$appDir\debug.keystore" --ks-pass pass:android --key-pass pass:android "$appDir\Klipperraker-Pro.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

$versionedApk = "$appDir\Klipperraker-Pro-v$vName.apk"
Copy-Item "$appDir\Klipperraker-Pro.apk" $versionedApk -Force
Write-Host "SUCCESS: Built & signed v$vName (Build $vCode) at $appDir\Klipperraker-Pro.apk and $versionedApk"
