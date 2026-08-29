# build-wiki.ps1
# 从 docs/ 生成 GitHub Wiki 扁平页面副本。
#
# GitHub Wiki 是独立仓库且不支持子目录，因此本脚本：
#   1. 把 docs/ 的嵌套路径映射为扁平页面名（目录分隔符 -> 连字符）
#   2. 重写全部相对链接与锚点为 Wiki 页面链接
#   3. 生成 Home.md 与 _Sidebar.md
#
# 用法：
#   pwsh -File scripts/build-wiki.ps1                      # 仅生成到 build/wiki
#   pwsh -File scripts/build-wiki.ps1 -Push                # 生成并推送到 wiki 仓库
#   pwsh -File scripts/build-wiki.ps1 -Push -Remote <url>  # 指定 wiki 仓库地址

[CmdletBinding()]
param(
    [string]$DocsDir,
    [string]$OutDir,
    [string]$Remote  = 'https://github.com/xyingsoft/dsh-chat.wiki.git',
    [switch]$Push,
    [string]$CommitMessage = 'docs: 同步 docs/ 到 Wiki'
)

$ErrorActionPreference = 'Stop'

# 兼容 Windows PowerShell 5.1：$PSScriptRoot 不能用于参数默认值
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $DocsDir) { $DocsDir = Join-Path $scriptRoot '..\docs' }
if (-not $OutDir)  { $OutDir  = Join-Path $scriptRoot '..\build\wiki' }

$DocsDir = [System.IO.Path]::GetFullPath($DocsDir)
$OutDir  = [System.IO.Path]::GetFullPath($OutDir)

if (-not (Test-Path $DocsDir)) { throw "找不到 docs 目录: $DocsDir" }

# --- 1. 建立 相对路径 -> Wiki 页面名 的映射 ---------------------------------

function ConvertTo-PageName([string]$relPath) {
    # docs/README.md                              -> Home
    # docs/03-details/04-security-compliance.md   -> 03-details-04-security-compliance
    # docs/_meta/source-mapping.md                -> meta-source-mapping
    $p = $relPath -replace '\\', '/' -replace '\.md$', ''
    if ($p -eq 'README') { return 'Home' }
    $p = $p -replace '^_meta/', 'meta-'
    return ($p -replace '/', '-')
}

$files = Get-ChildItem -Path $DocsDir -Recurse -File -Filter *.md
$map = @{}   # 绝对路径(小写) -> 页面名
foreach ($f in $files) {
    $rel = $f.FullName.Substring($DocsDir.Length).TrimStart('\', '/')
    $map[$f.FullName.ToLower()] = ConvertTo-PageName $rel
}

# --- 2. 重写链接 -------------------------------------------------------------

# 目录链接在扁平 Wiki 中无对应页面，指向该层第一篇
$dirLanding = @{
    '01-requirements' = '01-requirements-01-positioning-and-boundaries'
    '02-architecture' = '02-architecture-01-overall-architecture'
    '03-details'      = '03-details-01-identity-and-permission'
    '04-roadmap'      = '04-roadmap-01-operation-states'
    '_meta'           = 'meta-documentation-workflow'
}

function Convert-Links([string]$text, [string]$sourceDir) {
    # 先处理目录链接，例如 ](./03-details/)
    $text = [regex]::Replace($text, '\]\(\.{1,2}/([A-Za-z0-9_\-]+)/\)', {
        param($m)
        $dir = $m.Groups[1].Value
        if ($dirLanding.ContainsKey($dir)) { return "](" + $dirLanding[$dir] + ")" }
        return $m.Value
    })

    # 匹配 ](相对路径[#锚点])
    return [regex]::Replace($text, '\]\((\.{1,2}/[^)\s]+)\)', {
        param($m)
        $target = $m.Groups[1].Value
        $parts  = $target -split '#', 2
        $path   = $parts[0]
        $anchor = if ($parts.Count -gt 1) { $parts[1] } else { $null }

        try {
            $abs = [System.IO.Path]::GetFullPath((Join-Path $sourceDir $path))
        } catch { return $m.Value }

        $page = $map[$abs.ToLower()]
        if (-not $page) { return $m.Value }   # 非 docs 内部链接，原样保留

        if ($anchor) { return "]($page#$anchor)" }
        return "]($page)"
    })
}

# --- 3. 生成页面 -------------------------------------------------------------

if (Test-Path $OutDir) { Get-ChildItem $OutDir -File -Filter *.md | Remove-Item -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

foreach ($f in $files) {
    $page    = $map[$f.FullName.ToLower()]
    $content = Get-Content $f.FullName -Raw
    $content = Convert-Links $content $f.DirectoryName
    $outFile = Join-Path $OutDir "$page.md"
    # Wiki 页面统一 UTF-8 无 BOM
    [System.IO.File]::WriteAllText($outFile, $content, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ("  {0,-52} -> {1}.md" -f $f.Name, $page)
}

# --- 4. 生成 _Sidebar.md -----------------------------------------------------

$sidebar = @'
### dsh-chat 设计 Wiki

**[首页](Home)**

**一、需求说明**
- [产品定位与边界](01-requirements-01-positioning-and-boundaries)
- [协作能力需求](01-requirements-02-collaboration-requirements)

**二、整体架构**
- [三层总体架构](02-architecture-01-overall-architecture)
- [插件化架构](02-architecture-02-plugin-model)
- [服务端与部署分层](02-architecture-03-server-and-deployment)

**三、技术细节**
- [身份、组织与权限](03-details-01-identity-and-permission)
- [投递与持久化](03-details-02-delivery-and-persistence)
- [性能、分片与限流](03-details-03-performance-and-limits)
- [安全与合规](03-details-04-security-compliance)
- [可观测性与运维](03-details-05-observability-and-ops)
- [契约与规范附录](03-details-06-contracts-and-conventions)

**四、项目排期**
- [关键操作状态矩阵](04-roadmap-01-operation-states)
- [最小可运行骨架](04-roadmap-02-minimum-skeleton)
- [迭代计划 P0–P4](04-roadmap-03-iteration-plan)
- [测试与验收策略](04-roadmap-04-test-strategy)

**元文档**
- [文档维护规范](meta-documentation-workflow)
- [原文档映射表](meta-source-mapping)
'@
[System.IO.File]::WriteAllText((Join-Path $OutDir '_Sidebar.md'), $sidebar, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  _Sidebar.md 已生成"

$pageCount = (Get-ChildItem $OutDir -File -Filter *.md).Count
Write-Host "`n生成完成：$pageCount 个页面 -> $OutDir"

# --- 5. 可选推送 -------------------------------------------------------------

if (-not $Push) {
    Write-Host "`n(未推送。加 -Push 参数可推送到 $Remote)"
    return
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("dshwiki-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
Write-Host "`n克隆 wiki 仓库..."
git clone $Remote $work 2>&1 | Out-Null

if (-not (Test-Path $work)) {
    # wiki 尚未初始化：需先在网页端创建首个页面
    throw "克隆 wiki 失败。若 wiki 从未创建过，请先在 GitHub 网页端创建任意一个页面以初始化 wiki 仓库，然后重试。"
}

Get-ChildItem $work -File -Filter *.md | Remove-Item -Force
Copy-Item (Join-Path $OutDir '*.md') $work -Force

Push-Location $work
try {
    git add -A
    $status = git status --porcelain
    if (-not $status) { Write-Host "无变更，跳过推送。"; return }
    git commit -q -m $CommitMessage
    git push origin HEAD 2>&1 | Select-Object -Last 3
    Write-Host "`n推送完成。"
} finally {
    Pop-Location
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
