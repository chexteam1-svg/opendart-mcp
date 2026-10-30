# OpenDART API 키를 윈도우 사용자 환경변수 DART_API_KEY 로 저장한다.
# 입력은 화면에 보이지 않고, 키 값은 어디에도 출력하지 않는다.
# 결과(성공/실패 사유만)는 %LOCALAPPDATA%\opendart-mcp\set-key-result.txt 에 남긴다 — Claude 가 확인용으로 읽는다.
$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:LOCALAPPDATA 'opendart-mcp'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'set-key-result.txt'
function Done([string]$msg, [string]$color, [int]$code) {
    "$(Get-Date -Format s) $msg" | Out-File -FilePath $log -Encoding utf8
    Write-Host $msg -ForegroundColor $color
    Read-Host '창을 닫으려면 Enter'
    exit $code
}

Write-Host ''
Write-Host '== OpenDART API 키 등록 ==' -ForegroundColor Cyan
Write-Host 'opendart.fss.or.kr > 인증키 신청/관리 > 오픈API 이용현황 에 있는 40자리 키를 붙여넣고 Enter 를 누르세요.'
Write-Host '붙여넣기: 마우스 오른쪽 클릭 (Ctrl+V 가 안 먹으면 오른쪽 클릭) — 입력해도 화면엔 * 만 보이거나 아무것도 안 보여요.'
Write-Host ''
$sec = Read-Host -AsSecureString '인증키'
$key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()

if ($key.Length -ne 40) {
    Done "실패: 키 길이가 $($key.Length)자예요 (OpenDART 키는 40자). 저장하지 않았어요." Red 1
}

# 저장 전에 실제로 통하는지 확인 (삼성전자 기업개황 1건)
try {
    $r = Invoke-RestMethod -Uri "https://opendart.fss.or.kr/api/company.json?crtfc_key=$key&corp_code=00126380" -TimeoutSec 20
} catch {
    Done "실패: OpenDART 서버 연결 오류 — $($_.Exception.Message)" Red 1
}
if ($r.status -ne '000') {
    Done "실패: OpenDART 가 키를 거부했어요 (status $($r.status): $($r.message)). 저장하지 않았어요." Red 1
}

[Environment]::SetEnvironmentVariable('DART_API_KEY', $key, 'User')
Done "성공: 시험 조회 $($r.corp_name) / 대표 $($r.ceo_nm). DART_API_KEY 환경변수로 저장했어요." Green 0
