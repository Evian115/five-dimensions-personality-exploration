# Run in an elevated Windows PowerShell when Docker runs inside WSL.
# Opens only the website's TCP port; does not disable either firewall.
#Requires -RunAsAdministrator
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8080,
    [System.Net.IPAddress]$ListenAddress,
    [ValidateRange(1, 65535)]
    [int]$TargetPort = $Port
)

$ErrorActionPreference = 'Stop'
$ruleName = "BigFive-Docker-$Port"
$wslCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'

if (-not (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $ruleName -DisplayName "Big Five website TCP $Port" `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Any
}

if (Get-Command New-NetFirewallHyperVRule -ErrorAction SilentlyContinue) {
    if (-not (Get-NetFirewallHyperVRule -Name $ruleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallHyperVRule -Name $ruleName -DisplayName "Big Five WSL TCP $Port" `
            -Direction Inbound -Action Allow -VMCreatorId $wslCreatorId `
            -Protocol TCP -LocalPorts $Port
    }
}

if ($ListenAddress) {
    if ($ListenAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        throw 'ListenAddress must be an IPv4 address assigned to Windows.'
    }
    if (-not $ListenAddress.Equals([System.Net.IPAddress]::Any)) {
        Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ListenAddress.IPAddressToString -ErrorAction Stop | Out-Null
    }
    Set-Service iphlpsvc -StartupType Automatic
    Start-Service iphlpsvc
    & "$env:SystemRoot\System32\netsh.exe" interface portproxy add v4tov4 `
        listenaddress=$($ListenAddress.IPAddressToString) listenport=$Port `
        connectaddress=127.0.0.1 connectport=$TargetPort
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure Windows port forwarding.' }
    Write-Host "Forwarding $($ListenAddress.IPAddressToString):$Port to localhost:$TargetPort."
}

Write-Host "Website TCP port $Port is allowed."
