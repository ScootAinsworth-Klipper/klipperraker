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

Write-Host "SUCCESS: APK built and signed at $appDir\Klipperraker-Pro.apk"
