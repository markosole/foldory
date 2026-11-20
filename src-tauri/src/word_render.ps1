param([string]$InputPath, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
$wordApp = $null
$wordDoc = $null
try {
    $wordApp = New-Object -ComObject Word.Application
    $wordApp.Visible = $false
    $wordApp.DisplayAlerts = 0
    $wordApp.AutomationSecurity = 3
    $wordApp.Options.UpdateLinksAtOpen = $false
    $wordApp.Options.UpdateFieldsAtPrint = $false
    $wordApp.Options.UpdateLinksAtPrint = $false
    $no = $false
    $yes = $true
    $wordDoc = $wordApp.Documents.Open([ref]$InputPath, [ref]$no, [ref]$yes, [ref]$no)
    $wordDoc.ExportAsFixedFormat($OutputPath, 17, $false)
} finally {
    try {
        if ($null -ne $wordDoc) {
            try { $doNotSave = 0; $wordDoc.Close([ref]$doNotSave) }
            finally { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($wordDoc) }
        }
    } finally {
        if ($null -ne $wordApp) {
            try { $doNotSave = 0; $wordApp.Quit([ref]$doNotSave) }
            finally { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($wordApp) }
        }
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
