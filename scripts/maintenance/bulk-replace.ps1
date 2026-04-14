$files = Get-ChildItem -Path "src" -Recurse -Filter "*.js"

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw

    if ($content -match "supabaseDbShim|config/firebase") {

        $content = $content -replace "require\('\.\./\.\./core/supabaseDbShim'\)", "require('../../config/supabase')"
        $content = $content -replace "require\('\.\./core/supabaseDbShim'\)", "require('../config/supabase')"
        $content = $content -replace "require\('\.\./config/firebase'\)", "require('../config/supabase')"
        $content = $content -replace "require\('\.\./\.\./config/firebase'\)", "require('../../config/supabase')"

        Set-Content -Path $file.FullName -Value $content
        Write-Host "Updated: $($file.FullName)"
    }
}