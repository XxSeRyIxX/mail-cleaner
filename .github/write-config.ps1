# Writes app/config.json for a deploy or a build: the default sign-in apps from the environment, the commit and, for
# releases, the version. Empty values keep the repository's, so users register their own apps.
$path = 'app/config.json'
$config = Get-Content $path -Raw | ConvertFrom-Json
$config | Add-Member build $env:GITHUB_SHA.Substring(0, 7) -Force
if ($env:VERSION) { $config | Add-Member version $env:VERSION -Force }
if ($env:MICROSOFT_CLIENT_ID) { $config.microsoft.clientId = $env:MICROSOFT_CLIENT_ID }
if ($env:MICROSOFT_TENANT) { $config.microsoft.tenant = $env:MICROSOFT_TENANT }
if ($env:GOOGLE_CLIENT_ID) { $config.google.clientId = $env:GOOGLE_CLIENT_ID }
if ($env:GOOGLE_CLIENT_SECRET) { $config.google | Add-Member secret $env:GOOGLE_CLIENT_SECRET -Force }
$config | ConvertTo-Json -Depth 5 | Set-Content $path -Encoding utf8NoBOM
