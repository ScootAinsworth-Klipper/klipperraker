param(
    [switch]$Bump,
    [string]$Title,
    [string]$Notes
)

$ErrorActionPreference = "Stop"
$appDir = "C:\Gemini\KlipperController-App"
Set-Location $appDir

# Step 1: Optionally bump and build
if ($Bump) {
    Write-Host "Bumping version and compiling APK..."
    & "$appDir\build.ps1" -Bump
    if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed" }
} else {
    if (-not (Test-Path "$appDir\Klipperraker-Pro.apk")) {
        Write-Host "Building APK..."
        & "$appDir\build.ps1"
        if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed" }
    }
}

# Step 2: Read version from AndroidManifest.xml
$manifest = [System.IO.File]::ReadAllText("$appDir\AndroidManifest.xml", [System.Text.Encoding]::UTF8)
$vCodeMatch = [regex]::Match($manifest, 'android:versionCode="(\d+)"')
$vNameMatch = [regex]::Match($manifest, 'android:versionName="([^"]+)"')
if (-not $vCodeMatch.Success -or -not $vNameMatch.Success) {
    throw "Could not parse version from AndroidManifest.xml"
}
$vCode = $vCodeMatch.Groups[1].Value
$vName = $vNameMatch.Groups[1].Value
$tagName = "v$vName"

# Step 3: Get GitHub token and repository
$token = (git config --local klipper.github-token)
if (-not $token) {
    $remoteUrl = (git remote get-url origin)
    $m = [regex]::Match($remoteUrl, 'https://([^@]+)@')
    if ($m.Success) { $token = $m.Groups[1].Value }
}
if (-not $token) { $token = $env:GITHUB_TOKEN }
if (-not $token) { throw "GitHub token not found. Set via: git config --local klipper.github-token <token>" }

$repo = "ScootAinsworth-Klipper/klipperraker"

# Step 4: Commit any pending version bump changes and push main
$gitStatus = (git status --porcelain)
if ($gitStatus) {
    cmd.exe /c "git add AndroidManifest.xml assets/app.js assets/index.html assets/styles.css build.ps1 release.ps1 Klipperraker-Pro.apk.idsig"
    cmd.exe /c "git commit -m `"Release $tagName (Build $vCode)`""
}

Write-Host "Pushing main to GitHub..."
cmd.exe /c "git push origin main"
if ($LASTEXITCODE -ne 0) { throw "git push failed" }

# Step 5: Prepare Release Title & Notes
if (-not $Title) {
    $lastCommitMsg = (git log -1 --pretty=%s)
    $Title = "$tagName - $lastCommitMsg"
}
if (-not $Notes) {
    $Notes = "### Changes in $tagName (Build $vCode)`n`n" + (git log -1 --pretty=%B)
}

$headers = @{
    "Authorization" = "token $token"
    "Accept"        = "application/vnd.github.v3+json"
    "User-Agent"    = "Klipperraker-Release-Script"
}

# Step 6: Find or Create GitHub Release
$releaseApiUrl = "https://api.github.com/repos/$repo/releases"
$release = $null

try {
    $release = Invoke-RestMethod -Uri "$releaseApiUrl/tags/$tagName" -Headers $headers -Method Get -ErrorAction Stop
    Write-Host "Found existing release for $tagName (ID: $($release.id))"
} catch {
    Write-Host "Creating new GitHub Release for $tagName..."
    $bodyJson = @{
        tag_name   = $tagName
        name       = $Title
        body       = $Notes
        draft      = $false
        prerelease = $false
    } | ConvertTo-Json

    $release = Invoke-RestMethod -Uri $releaseApiUrl -Headers $headers -Method Post -Body $bodyJson -ContentType "application/json"
}

$releaseId = $release.id

# Step 7: Check and Delete existing Klipperraker-Pro.apk asset if present
$existingAsset = ($release.assets | Where-Object { $_.name -eq "Klipperraker-Pro.apk" })
if ($existingAsset) {
    Write-Host "Deleting existing Klipperraker-Pro.apk asset ($($existingAsset.id))..."
    Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/assets/$($existingAsset.id)" -Headers $headers -Method Delete | Out-Null
}

# Step 8: Upload signed APK to release
$apkPath = "$appDir\Klipperraker-Pro.apk"
$apkBytes = [System.IO.File]::ReadAllBytes($apkPath)
$uploadUrl = "https://uploads.github.com/repos/$repo/releases/$releaseId/assets?name=Klipperraker-Pro.apk"

Write-Host "Uploading Klipperraker-Pro.apk ($([math]::Round($apkBytes.Length / 1KB, 1)) KB) to GitHub Release $tagName..."
$uploadHeaders = @{
    "Authorization" = "token $token"
    "Accept"        = "application/vnd.github.v3+json"
    "User-Agent"    = "Klipperraker-Release-Script"
    "Content-Type"  = "application/vnd.android.package-archive"
}

$uploadResp = Invoke-RestMethod -Uri $uploadUrl -Headers $uploadHeaders -Method Post -Body $apkBytes
Write-Host "`nSUCCESS! Release $tagName published on GitHub:"
Write-Host "  URL: $($release.html_url)"
Write-Host "  Asset: $($uploadResp.browser_download_url)"
