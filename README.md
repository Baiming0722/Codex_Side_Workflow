# Codex 工作流監控外掛 & 多模型子代理自動配置方案

> **版本：`v0.3.2`**｜適用於 **ChatGPT Desktop / Codex**（MCP Apps 側邊分頁）與 **Codex CLI**  
> 內含兩項可獨立或合併使用的元件：
> 1. **`codex-workflow-monitor` 本機外掛**：以終端機 TUI 數據流風格即時視覺化呈現單模型與多子代理運行狀態，預設唯讀讀取本機狀態，開箱即用。
> 2. **四模型多子代理自動配置規格**：一份可直接交給 Codex 執行的安全配置手冊（Phase A 唯讀 Diff 預覽 → 人工批准 → Phase B 備份寫入 → Phase C 嚴格驗證），協助導入 `Sol` / `Luna` / `Terra` / `Astra` 協作架構。

---

## 目錄

- [功能亮點](#功能亮點)
- [系統架構與節點連動](#系統架構與節點連動)
- [環境需求與離線預覽](#環境需求與離線預覽)
- [快速開始一：安裝 Codex 工作流監控外掛](#快速開始一安裝-codex-工作流監控外掛)
- [快速開始二（選用）：一鍵配置四模型多子代理](#快速開始二選用一鍵配置四模型多子代理)
- [專案目錄與提供的 MCP 工具](#專案目錄與提供的-mcp-工具)
- [隱私、安全與隔離邊界](#隱私安全與隔離邊界)
- [Codex 多模型子代理自動配置完整規格](#codex-多模型子代理自動配置完整規格)
  - [0. 給 Codex 的執行指令與不可違反限制](#0-給-codex-的執行指令與不可違反限制)
  - [1. Preflight 唯讀檢查](#1-preflight-唯讀檢查不得寫入)
  - [2. 寫入目標與設定檔模板](#2-寫入目標與設定檔模板)
  - [3. 全域 AGENTS.md 協作規範](#3-全域-agentsmd-協作規範)
  - [4. 分階段執行流程（Phase A-C）](#4-分階段執行流程phase-a-c)
  - [5. 驗收條件、反模式與交付報告格式](#5-驗收條件反模式與交付報告格式)
- [版本更新摘要](#版本更新摘要)
- [授權與作者](#授權與作者)
- [官方參考資料](#官方參考資料)

---

## 功能亮點

### 1. TUI 數據流視覺化監控面板（`codex-workflow-monitor`）
- **終端機點陣數據流風格**：保留點陣框線、動態正交數據連線與流動光點，專為 ChatGPT Desktop／Codex 的 `thread` / `global` 側邊分頁打造（繁體中文介面）。
- **三態發光邏輯（只點亮正在運行的部分）**：
  - **運行中（發光）**：正在推理的主模型、活躍中的工具模組與正在執行的子代理與連線高亮發光。
  - **已完成（熄滅）**：已執行完畢的節點自動熄滅並標示完成狀態。
  - **未使用（暗化／隱藏）**：未觸發的功能模組與子代理低調待命，並可透過頂部 **「精簡隱藏」** 一鍵收合未用節點。
- **單模型與多子代理自動適配**：
  - 單獨使用單一模型（例如 `GPT-6.2-Sol`）時，僅呈現主模型、即時活動與已啟用的功能模組，不佔用多餘子代理空間。
  - 動態派發任何子代理（標準 `search` / `grep` / `audit` / `advisor` 或自訂子代理）時，自動展開子代理協作區並獨立追蹤各代理進度。
- **零侵入即開即用**：透過 Node 內建唯讀 `node:sqlite` 直接觀測 `$CODEX_HOME/state_*.sqlite`、`thread_history_*.sqlite` 與活躍執行緒的 `rollout-*.jsonl` 尾端中繼資料；同時相容合併外掛內建的選用 Hooks（`~/.codex-workflow-monitor/events.jsonl`）。
- **完整即時指標與範圍切換**：
  - 支援頂部 **「對話（Session）／輪次（Turn）」** 統計範圍即時切換。
  - 顯示主模型、功能模組與子代理的完成度、調用次數、工具呼叫數、即時運行時間（每秒更新）與 Token 用量。
  - 自動過濾監控外掛自身的工具輪詢（`open_workflow_monitor`、`read_workflow_events`、`clear_workflow_events`），避免誤觸發光。

### 2. 安全可控的四模型多子代理協作方案（選用）
- **增量導入、絕不暴力覆寫**：採用 Phase A（唯讀盤點 + Unified Diff 預覽）→ 人工批准 → Phase B（時間戳記備份 + 安全寫入）→ Phase C（TOML 與 `codex --strict-config doctor` 驗證）三階段流程。
- **保留既有設定**：不覆蓋既有 MCP 伺服器、外掛、沙盒模式、核准政策或其他自訂代理；若原主模型與目標衝突，先詢問使用者選擇。
- **跨版本 TOML 相容**：避開舊版 `codex-cli 0.162.x` 與新版 `0.170.0+` 在 `[agents]` 表上的相容性陷阱。

---

## 系統架構與節點連動

外掛可單獨用於日常單模型開發；若進一步套用本儲存庫的四模型子代理配置，面板會依 `agent_role`／`agent_type`／模型名稱自動上色並對應到專屬位置：

```text
┌───────────────────┐     ┌────────────────────────────────────────┐     ┌──────────────────┐
│  ASTRA 顧問欄     │◄───►│  主模型（Sol · gpt-6.2-sol）           │────►│ RUNTIME 執行資源 │
│  (advisor / gold) │     │  即時狀態 · 回合 · 進度 · 耗時         │     │ 完成度 · Token   │
│  · 規劃鎖定前     │     └──────────────────┬─────────────────────┘     └──────────────────┘
│  · 連續失敗兩次   │                        ▼
│  · 交付終審關卡   │     ┌────────────────────────────────────────┐
│  [ASTRA CHECKED]  │     │  功能與調度層（9 大能力模組即時高亮）  │
└───────────────────┘     │  推理 · 搜尋 · 終端 · 編修 · MCP · ... │
                          └──────────────────┬─────────────────────┘
                                             ▼ （僅於派發子代理時動態點亮）
                          ┌────────────────────────────────────────┐
                          │  Luna Search  │  Luna Grep  │ Terra Audit │ （亦支援自訂子代理）
                          └──────────────────┬─────────────────────┘
                                             ▼
                          ┌────────────────────────────────────────┐
                          │  back to 主模型（整合交付與總結）      │
                          └────────────────────────────────────────┘
```

### 四模型角色與監控面板對應表

| 角色 | 代理名稱 (`name`) | 顯示別名 (`nickname_candidates`) | 預設模型 (`model`) | 推理程度 | 面板節點與色系 | 工作職責 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 主代理 | 主會話 | `Sol` | `gpt-6.2-sol` | `xhigh` | 中央主模型（紫色） | 需求理解、編碼、修改、整合與最終交付 |
| 快速探索 | `search` | `Luna Search` | `gpt-6-luna` | `xhigh` | 子代理區（青色） | Repository 廣度探索、定位檔案與模組入口 |
| 精準搜尋 | `grep` | `Luna Grep` | `gpt-6-luna` | `xhigh` | 子代理區（青色） | 符號引用、定義、呼叫鏈與相依性追蹤 |
| 獨立驗證 | `audit` | `Terra Audit` | `gpt-6.1-terra` | `xhigh` | 子代理區（綠色） | 差異審查、必要的安全測試與回歸風險回報 |
| 高階顧問 | `advisor` | `Astra Advisor` | `gpt-6.2-astra` | `xhigh` | 左側顧問欄（金色） | 重大架構把關、連續失敗根因分析、重要交付終審 |

> **模型版本備註：** 目前 Codex 官方模型目錄中 Terra 家族最新可用版本為 `gpt-6.1-terra`（尚無 `gpt-6.2-terra`）。執行配置前會由 `codex debug models` 或 `$CODEX_HOME/models_cache.json` 實際核實；若未來已釋出更新版本，可在 Phase A 預覽階段提議升級。

### 功能與調度層自動分類（9 大能力模組）
無論單模型或子代理，工具呼叫皆自動歸類至以下模組並即時統計次數與運行狀態：`深度推理`、`搜尋與讀取`、`終端指令`、`檔案編修`、`MCP 工具`、`網路檢索`、`影像處理`、`脈絡壓縮`、`計畫規劃`。

---

## 環境需求與離線預覽

### 環境需求
- **Node.js**：`22.5+`（建議 **`24+`**，以使用內建唯讀 `node:sqlite` 直接觀測本機 Codex 狀態資料庫）。
- **Codex CLI / ChatGPT Desktop（Codex）**：支援本機 Plugin Marketplace 與 MCP Apps 側邊分頁之版本（已於 `codex-cli 0.170.0` 驗證指令與設定相容性）。
- **Python 3（選用）**：僅在啟用外掛內建 Hooks（`hooks/record_event.py`）時需要；未啟用 Hook 或無 Python 環境時，外掛仍可透過 `node:sqlite` 正常監控。

### 免安裝即時預覽介面
在安裝外掛前，可直接以瀏覽器開啟專案根目錄的 [`preview-zh.html`](./preview-zh.html)，內建三種互動示範情境可供切換體驗：
- **單模型 GPT-6.2-Sol**
- **呼叫 Subagent 協作**
- **全部完成（熄滅）**

---

## 快速開始一：安裝 Codex 工作流監控外掛

### 1. 下載儲存庫並建置驗證外掛

> 請先在本機安裝依賴並編譯前端橋接腳本（`dist/bridge.js`），再透過本機 Marketplace 註冊，確保 MCP 伺服器與 UI 資源完整可用。

**macOS / Linux（Bash / Zsh）：**
```bash
git clone https://github.com/Baiming0722/Codex_Side_Workflow.git
cd Codex_Side_Workflow

cd plugins/codex-workflow-monitor
npm install
npm run build
npm run check
npm test
cd ../..
```

**Windows（PowerShell）：**
```powershell
git clone https://github.com/Baiming0722/Codex_Side_Workflow.git
Set-Location Codex_Side_Workflow

Set-Location plugins\codex-workflow-monitor
npm install
npm run build
npm run check
npm test
Set-Location ..\..
```

### 2. 加入本機 Marketplace 並安裝外掛

在**專案根目錄**（含 `.agents/plugins/marketplace.json` 的資料夾）執行：

```bash
codex plugin marketplace add .
codex plugin add codex-workflow-monitor@codex-workflow-local
```

完成後，重新開啟 **ChatGPT Desktop／Codex**（或重載對話側邊分頁），在側邊分頁或工具選單點選 **Codex Workflow** 即可啟用即時監控。

### 3. 更新已安裝的舊版外掛

當拉取新版本並重新執行 `npm install && npm run build` 後，移除舊快取並重新安裝：

```bash
codex plugin remove codex-workflow-monitor@codex-workflow-local
codex plugin add codex-workflow-monitor@codex-workflow-local
```

---

## 快速開始二（選用）：一鍵配置四模型多子代理

本步驟為**完全選用**。如果您希望將全域 Codex 配置為「Sol 主導實作 + Luna 探索搜尋 + Terra 獨立審查 + Astra 高階顧問」，**不需要手動複製貼上設定檔**——直接將本專案交給 Codex，並貼上以下啟動指令，讓 Codex 依照下方完整規格執行安全的兩階段配置：

```text
請讀取本儲存庫的 README.md 中「Codex 多模型子代理自動配置完整規格」章節，並從第 0 節開始嚴格遵守執行。
目標是配置本機 Codex 的全域多模型子代理：Sol 主代理 (gpt-6.2-sol)、Luna search/grep (gpt-6-luna)、Terra audit (gpt-6.1-terra)、Astra advisor (gpt-6.2-astra)，推理程度統一為 xhigh。
先執行 Phase A：盤點當前環境、核實 models_cache.json 與 CLI 支援情況，產生所有預計變更的完整 Unified Diff（若我現有 config.toml 的主模型設定不同，請列出選項讓我決定是否保留原主模型）。
這一輪禁止修改檔案、安裝工具、改變權限或建立 Worktree。
完成後等待我回覆「繼續」，才可進入 Phase B 套用並執行 Phase C 驗證。
```

**操作方式：**
1. 貼上上述指令後，檢視 Codex 回報的環境盤點結果、模型支援狀態、主模型保留選項與完整 Unified Diff。
2. 確認不會破壞您既有設定後，回覆 **「繼續」**，Codex 才會先建立時間戳記備份，再套用設定並執行 TOML 與 CLI 嚴格檢查。

---

## 專案目錄與提供的 MCP 工具

### 專案目錄結構

```text
.
├── .agents/plugins/marketplace.json               # 本機外掛市集宣告（codex-workflow-local）
├── .gitignore                                     # Git 忽略規則
├── LICENSE                                        # MIT 開源授權條款
├── preview-zh.html                                # 獨立瀏覽器互動預覽版（免安裝可檢視三種情境）
├── README.md                                      # 專案總覽、安裝指南與多模型子代理自動配置規格
└── plugins/codex-workflow-monitor/
    ├── plugin.json                                # 外掛中繼宣告（v0.3.2）
    ├── mcp.json                                   # 使用 ${PLUGIN_ROOT} 的本機 stdio MCP 伺服器設定
    ├── package.json                               # 建置（esbuild）、語法檢查與驗證測試腳本
    ├── hooks/
    │   ├── hooks.json                             # 選用事件 Hook 宣告（14 類非同步事件）
    │   └── record_event.py                        # 僅記錄安全中繼資料的 Python Hook 腳本
    ├── server/
    │   ├── index.mjs                              # MCP 伺服器入口與 UI 資源封裝
    │   └── telemetry.mjs                          # 唯讀本機遙測引擎（SQLite + rollout 尾端 + Hook 合併）
    ├── public/
    │   └── monitor-zh.html                        # 繁體中文 TUI 數據流側邊分頁介面
    ├── src/bridge.mjs                             # UI 與 MCP App 宿主握手及輪詢橋接原始碼
    ├── dist/bridge.js                             # esbuild 編譯壓縮後的橋接腳本（npm run build 產生）
    └── test/verify.mjs                            # 自動化測試（HTML/JS 語法、單/多代理邏輯、stdio MCP 端到端）
```

### 外掛註冊的 MCP 工具與資源

| 項目 | 類型 | 存取屬性 | 說明 |
| :--- | :--- | :--- | :--- |
| `ui://codex-workflow/monitor.html` | App Resource | 唯讀 | 提供內嵌 `dist/bridge.js` 的側邊分頁互動 UI |
| `open_workflow_monitor` | App Tool | 唯讀 | 開啟側邊分頁（`thread` / `global`），回傳初始即時快照；支援 `session_id` 與 `scope`（`session` / `turn`） |
| `read_workflow_events` | Tool | 唯讀 | 讀取指定或自動追蹤工作階段的即時模型、能力模組、子代理與安全事件中繼資料 |
| `clear_workflow_events` | Tool | 寫入（僅限自管紀錄） | 僅清空 `~/.codex-workflow-monitor/events.jsonl`，不觸碰任何 Codex 原生資料庫 |

---

## 隱私、安全與隔離邊界

### 監控外掛的隱私邊界
- **嚴格唯讀中繼資料**：僅對 `$CODEX_HOME` 下的狀態資料庫（`state_*.sqlite`、`thread_history_*.sqlite`）與活躍執行緒的 `rollout-*.jsonl` 尾端讀取**結構化中繼資料**（模型名稱、推理強度、回合狀態、時間戳、工具類別與數值統計）。
- **不讀取也不回傳敏感本文**：不讀取、不記錄、不輸出對話提示詞、AI 回覆內文、工具輸入參數、工具輸出內容、API 金鑰或登入憑證。
- **不改動 Codex 原生檔案**：外掛運行期間絕不寫入或修改任何 Codex 資料庫或設定檔；`clear_workflow_events` 僅清空外掛自身位於 `~/.codex-workflow-monitor/events.jsonl` 的選用 Hook 紀錄。

### 多模型子代理的權限與隔離邊界
- **角色提示不等於系統隔離**：子代理繼承主會話的沙盒（Sandbox）與核准政策（Approval Policy）；`search` / `grep` / `audit` / `advisor` 的「唯讀」屬於行為約束與工具表面收斂，**並非獨立唯讀沙盒**。
- **`audit` 不自動等於 Git Worktree**：子代理預設與主會話共享工作樹，僅執行不修改來源檔的 diff 審查與無副作用測試。若需強隔離，須由使用者許可後明確使用可控的 Git Worktree（或 `codex --worktree`），並確認審查環境包含要檢驗的實際未提交修改。
- **不納入 JEV／第三方代理路由器**：這套配置完全建構於 Codex 原生 Subagents 與 Custom Agents 機制之上，不修改網路 Proxy、API Base URL、模型提供商、認證或網路攔截設定。

---

## Codex 多模型子代理自動配置完整規格

> **說明**：以下章節是供 Codex 直接執行的標準配置規格與模板（原《Codex 多模型子代理：自動配置說明書 v1.1》整合修訂版）。閱讀本節本身不會修改任何本機設定；適用範圍為個人全域配置（預設 `~/.codex/`，若環境變數已設定 `CODEX_HOME` 則以該目錄為準）。

### 0. 給 Codex 的執行指令與不可違反限制

**如果你是被要求配置自身環境的 Codex，請從這裡開始完整遵守以下規則。**

目標是在現有本機全域設定上，以增量、不破壞既有環境的方式導入上表所述的四模型多子代理分工（`Sol` / `search` / `grep` / `audit` / `advisor`，推理強度統一為 `xhigh`）。未涵蓋的細節可依官方現行規範合理判斷並於預覽報告說明。

#### 不可違反的 10 項限制

1. **首次執行嚴格唯讀**：Phase A 只做唯讀盤點、模型核實、準備變更方案與完整 Unified Diff，**禁止寫入任何檔案**。收到使用者明確回覆「繼續／套用／批准」後，才可進入 Phase B（同樣適用於升級、安裝或替換模型）。
2. **嚴格限定修改範圍**：只修改個人全域 `$CODEX_HOME` 下的 `config.toml`、`AGENTS.md` 與 `agents/*.toml`；不得改動任何專案原始碼、Git 分支、依賴、測試或 CI。
3. **禁止暴力覆寫既有設定**：先盤點既有 `config.toml`、`AGENTS.md`、`agents/*.toml`；不得刪除既有代理、MCP、外掛、核准政策或沙盒設定。若既有主模型或推理設定與本方案衝突（例如原本設為 `gpt-6.2-astra` 或 `max`），必須於 Phase A 明確列出衝突並請使用者決定「切換為 `gpt-6.2-sol` (`xhigh`)」或「保留原主模型、僅新增子代理」。
4. **保持 TOML 結構與註解完整**：原地編輯時不得產生重複鍵、重複表格，或將頂層鍵誤寫進 `[agents]` 表內。寫入前必須備份，寫入後必須驗證。
5. **不捏造也不默默降級模型**：若指定模型或設定鍵不被當前客戶端支援，不得編造替代 ID、不得靜默降級、不得假稱成功；須於預覽報告提出可用替代方案待批。
6. **維持現行安全權限**：全程使用現有沙盒與核准政策，不使用 `--yolo`、`danger-full-access`，不提升權限，不安裝 JEV／Proxy，不要求或輸出登入憑證。
7. **如實說明隔離能力**：不得宣稱子代理自動擁有獨立唯讀沙盒或獨立 Git Worktree。
8. **失敗即回滾**：未經批准不做額外清理；Phase B 任何一步失敗時，立即從備份恢復本次改動並回報原因。
9. **避免過度委派**：單次 `rg`、`git status`、簡單讀檔或小改動由主代理直接執行，不把所有命令都委派給子代理。
10. **受限環境誠實回報**：若執行環境無法寫入本機設定（例如雲端工作階段），應明確說明限制並輸出可供手動套用的檔案內容，不得宣稱已完成本機配置。

---

### 1. Preflight 唯讀檢查（不得寫入）

依序執行以下檢查：

1. 確認作業系統、Codex 執行環境與 `CODEX_HOME` 路徑（預設 `~/.codex`）。
2. 若 CLI 可用，執行唯讀指令檢查版本、Feature Flags 與模型目錄（命令不存在時不得猜測輸出）：
   ```sh
   codex --version
   codex features list
   codex doctor
   codex debug models
   ```
3. 唯讀檢查（若存在）：`$CODEX_HOME/config.toml`、`$CODEX_HOME/AGENTS.md`、`$CODEX_HOME/agents/*.toml`，盤點既有同名代理與同名鍵，確認現有 TOML 可正確解析，並檢查是否存在更高優先權的專案設定或管理政策。
4. **核實模型與推理強度可用性**：透過 `codex debug models` 或唯讀檢視 `$CODEX_HOME/models_cache.json`，確認 `gpt-6.2-sol`、`gpt-6-luna`、`gpt-6.1-terra`、`gpt-6.2-astra` 的 `slug` 是否存在，以及各模型的 `supported_reasoning_levels` 是否支援 `xhigh`。因實際呼叫仍受帳號訂閱等級約束，若當下無法實測呼叫，須標註「快取已核實／實際會話待核實」。
5. 產生完整 **Unified Diff**（新檔案舊版為 `/dev/null`），列出預計新增／修改／保留不動的檔案、衝突與處理選項、驗證方式及一鍵回復方法，然後**停止等待使用者批准**。

---

### 2. 寫入目標與設定檔模板

預設寫入個人全域 `$CODEX_HOME`（不寫入個別專案目錄；若已有同名代理，於 Phase A 提出合併或更名方案，不直接覆蓋）：

```text
$CODEX_HOME/                 # 預設 ~/.codex
├── config.toml              # 僅合併目標鍵，保留其餘既有設定與註解
├── AGENTS.md                # 僅新增／更新專用 HTML 標記區段
└── agents/
    ├── search.toml
    ├── grep.toml
    ├── audit.toml
    └── advisor.toml
```

#### 2.1 `config.toml` 目標值與相容性說明

合併以下**頂層鍵**與 `[agents]` 表（若 `[agents]` 或同名鍵已存在，就地更新，勿產生重複表格或重複鍵）：

```toml
# 主要會話：Sol
model = "gpt-6.2-sol"
model_reasoning_effort = "xhigh"

[agents]
max_concurrent_threads_per_session = 4
default_subagent_model = "gpt-6-luna"
default_subagent_reasoning_effort = "xhigh"
```

- **為何省略 `[agents].enabled = true`**：在 `codex-cli 0.170.0+` 中 `agents.enabled` 預設已為 `true`；但在 `0.162.x` 中，`[agents]` 下的未知鍵會被當成自訂角色子表（`AgentRoleToml`），寫入 `enabled = true` 反而觸發 `Ignoring malformed agent role definition` 警告。省略此鍵可同時相容新舊版本。
- `max_concurrent_threads_per_session = 4` 表示同時最多開啟 4 個子代理執行緒（不含主代理），非強制每次皆開滿。
- 各 `agents/*.toml` 內的 `model` 與 `model_reasoning_effort` 會覆蓋 `default_subagent_*`；預設值僅套用於未指定模型的臨時匿名子代理。
- 僅當現有 `[features]` 顯式將 `multi_agent = false` 時，才提出最小化改動設為 `true`；若未設定或已為 `true`，不增添多餘鍵。
- 不修改既有 `sandbox_mode`、`approval_policy`、`model_provider`、`mcp_servers`、`plugins`、`marketplaces` 等設定。

#### 2.2 四份子代理定義檔（`agents/*.toml`）

<details>
<summary><strong>展開檢視：<code>agents/search.toml</code>（Luna Search · 快速探索）</strong></summary>

```toml
name = "search"
description = "Low-cost, read-oriented repository explorer: identify likely files, modules, ownership and implementation paths."
model = "gpt-6-luna"
model_reasoning_effort = "xhigh"
nickname_candidates = ["Luna Search"]

developer_instructions = """
你是搜尋與專案探索子代理（Luna Search）。預設唯讀。
目標：快速定位與任務直接相關的檔案、模組、入口點、設定及測試位置。
優先使用 rg --files、rg、精準檔案讀取或唯讀 git 指令，不要盲目輸出整個 repository。
只回傳有依據的檔案路徑、符號、必要行號、關聯與未確認事項。
絕不修改原始碼、測試、文件或配置；不要清除檔案或執行具副作用的命令。
如果搜尋範圍極小且主代理可直接完成，告知主代理無需後續委派。
"""

[features]
request_permissions_tool = false
```

</details>

<details>
<summary><strong>展開檢視：<code>agents/grep.toml</code>（Luna Grep · 精準引用與呼叫鏈）</strong></summary>

```toml
name = "grep"
description = "Precise symbol and call-chain locator: definitions, references, callers and dependencies."
model = "gpt-6-luna"
model_reasoning_effort = "xhigh"
nickname_candidates = ["Luna Grep"]

developer_instructions = """
你是精準引用與呼叫鏈分析子代理（Luna Grep）。預設唯讀。
根據主代理給定的符號或行為，找出定義、參照、呼叫端、被呼叫端與資料流。
先縮小搜尋範圍，再給出路徑、行號和關鍵證據，避免傾倒大量不相關內容。
明確區分實際確認與推測；遇到生成檔或第三方程式碼應清楚註明。
不得修改檔案、執行會改變工作樹的命令，或將分析擴大成自行重構。
"""

[features]
request_permissions_tool = false
```

</details>

<details>
<summary><strong>展開檢視：<code>agents/audit.toml</code>（Terra Audit · 獨立審查與驗證）</strong></summary>

```toml
name = "audit"
description = "Independent review and verification: inspect diffs, run scoped tests when safe, report regressions and evidence."
model = "gpt-6.1-terra"
model_reasoning_effort = "xhigh"
nickname_candidates = ["Terra Audit"]

developer_instructions = """
你是獨立程式碼審查與品質驗證子代理（Terra Audit）；預設不修改來源檔案。
檢查提交給你的 diff、變更範圍、邊界條件、相容性、資安、回歸風險與測試覆蓋。
必要時執行主代理准許且不會破壞環境的範圍測試；如測試會產生快取、產物或寫入，先明確告知。
不能透過修改原始碼或測試讓結果表面通過；不能使用破壞性清理命令。
每項發現要回報：嚴重程度、檔案/行號、重現條件、實際證據、建議修正。
明確區分 PASS、FAIL、NOT_RUN，不得將未執行測試寫成通過。
沒有獨立 Worktree 時，不得聲稱已在隔離環境執行；需要真正隔離時請主代理申請適當工作環境。
"""
```

</details>

<details>
<summary><strong>展開檢視：<code>agents/advisor.toml</code>（Astra Advisor · 高階架構與終審顧問）</strong></summary>

```toml
name = "advisor"
description = "High-stakes architecture advisor for pre-lock decisions, repeated failed fixes, and significant final reviews."
model = "gpt-6.2-astra"
model_reasoning_effort = "xhigh"
nickname_candidates = ["Astra Advisor"]

developer_instructions = """
你是高階技術顧問（Astra Advisor），不負責日常實作，也不自行更改工作目錄。
請只針對主代理提出的明確問題，審核架構選擇、根本原因或重大變更的驗收證據。
優先找出阻斷性風險、錯誤假設、介面衝突、測試缺口、資安與維護成本。
根據所提供的需求、diff、實際日誌和測試結果提出可操作的意見，不重做主代理已完成的簡單工作。
輸出格式：判定 APPROVE / REVISE / BLOCK；核心理由；必須修正的事項；待確認風險。
對缺少證據的部分標記未確認，不得宣稱已執行測試或已核准不可見的修改。
不得自行編輯檔案；最終採納與實作由主代理負責。
"""

[features]
request_permissions_tool = false
```

</details>

---

### 3. 全域 `AGENTS.md` 協作規範

若 `$CODEX_HOME/AGENTS.md` 已存在，保留原文並在末尾附加以下標記區塊；若標記已存在，僅更新兩個 HTML 註解標記之間的內容（不可出現兩份，且不可把本 README 其他章節寫進 `AGENTS.md`）。若與既有規則衝突，須先於 Phase A 提出。

<details>
<summary><strong>展開檢視：寫入 <code>$CODEX_HOME/AGENTS.md</code> 的標記區段</strong></summary>

```markdown
<!-- BEGIN: CODEX MULTI-AGENT GLOBAL RULES -->

## Codex 多模型協作規則

### 角色配置
- 主代理為 `gpt-6.2-sol`（`xhigh`）：負責需求理解、方案整合、程式實作、變更所有權與最終回報（若使用者當前會話顯式選用其他主模型，以當前會話設定為準）。
- `search`（`gpt-6-luna` / `xhigh`）：負責廣度探索、定位檔案與模組入口。
- `grep`（`gpt-6-luna` / `xhigh`）：負責精準符號、引用與呼叫鏈定位。
- `audit`（`gpt-6.1-terra` / `xhigh`）：負責獨立 diff 審查、必要的安全測試與回歸風險回報。
- `advisor`（`gpt-6.2-astra` / `xhigh`）：高階顧問，僅在重大架構決策、同一根因連續失敗兩次或重要交付終審時諮詢。
- 如果自訂代理或指定模型在目前執行環境不可用，先如實回報限制；不假冒已呼叫該代理。

### 委派判斷
1. 先評估任務大小、依賴關係、並行效益及 Token 成本。
2. 單次搜尋、讀檔、`rg`、簡單修正由主代理直接完成；**禁止為了保持主上下文乾淨而把每個微小工具呼叫都委派給子代理**。
3. 大量獨立模組探索時，可並行派發 `search` 與 `grep`，並明確交代問題、範圍與預期輸出格式。
4. 主代理獨占正式工作目錄的程式碼寫入；`search`、`grep`、`audit`、`advisor` 均不直接修改來源檔案。同一份檔案禁止並行寫入。
5. 變更完成後，視變更複雜度與風險委派 `audit` 審查 diff 與執行安全測試；主代理確認實際輸出後才宣告完成。
6. 子代理回傳的內容是證據與建議，主代理必須核實其適用性並負最終責任。
7. 子代理繼承父會話權限與沙盒設定，角色指令不提供系統級隔離；對隔離的要求不得以文字承諾代替實體保護。

### Astra (`advisor`) 三個觸發時機
1. **重大計畫鎖定前：** 影響公共 API、資料模型、安全邊界、部署、跨模組架構或不可逆操作時，先請 `advisor` 審核方案；普通簡單任務不觸發。
2. **同一根因疑似連續失敗兩次：** 收集重現步驟、兩輪嘗試紀錄、實際錯誤輸出與相關 diff，再請 `advisor` 分析根因；僅錯誤文字相似不足以認定同一根因。
3. **重大工作宣告完成前：** 將整合 diff、驗收標準及實際測試證據交由 `advisor` 終審。小型低風險變更由主代理與 `audit` 驗收即可，不必每次呼叫 `advisor`。

### 顧問請求與驗收回報
- 諮詢 `advisor` 時須附上：需求與限制、已知事實、已嘗試方法、必要 diff／錯誤輸出／測試紀錄，以及具體待決問題。
- `advisor` 回傳 `APPROVE` / `REVISE` / `BLOCK`，由主代理判斷並執行修正；若需求或程式碼隨後有重大變更，舊簽核自動失效。
- 最終回報須交代：修改檔案、主要決策、實際執行的測試與結果（嚴格區分 `PASS` / `FAIL` / `NOT_RUN`）、各子代理是否確實被呼叫，以及未確認風險。子代理未啟動不得寫成已完成審查。

<!-- END: CODEX MULTI-AGENT GLOBAL RULES -->
```

</details>

---

### 4. 分階段執行流程（Phase A-C）

#### Phase A — 唯讀調查與 Diff 預覽（第一次執行）
1. 完成第 1 節 Preflight（環境、CLI 版本、Feature Flags、既有設定盤點與模型目錄核實）。
2. 僅在記憶體中組裝候選設定，不寫入磁碟，輸出完整 **Unified Diff**。
3. 列出預計新增／修改／不動的檔案、模型支援結果、主模型衝突選項、驗證步驟與還原方案。
4. **停止並等待使用者明確回覆「繼續」**；不可將閱讀文件當作批准。

#### Phase B — 寫入（取得明確批准後）
1. 確認目標檔案自 Phase A 後未被外部修改；若有異動，須重新產出 Diff 並再次請求批准。
2. 建立帶時間戳記的原始檔案備份，並於報告記下完整備份路徑。
3. 合併更新 `config.toml`、寫入 `agents/*.toml`，以及更新 `AGENTS.md` 的專用標記區塊。
4. 採原子或等價安全寫入；任一步驟失敗即從備份回滾，不留下半套設定。
5. 比對落盤檔案與批准 Diff，確認無多餘改動或反斜線轉義殘留。

#### Phase C — 驗證
1. 以標準 TOML 解析器（例如 Python `tomllib`）檢查 `config.toml` 與全部 `agents/*.toml`：無語法錯誤、無重複鍵／表，必填欄位（`name`、`description`、`developer_instructions`）齊全。
2. 執行 `codex --strict-config doctor` 與 `codex debug prompt-input`，確認 CLI 可無錯載入新配置與 `AGENTS.md`。
3. 確認 `AGENTS.md` 僅含一組專用標記且保留原有規則。
4. 在**新開的 Codex 會話**以 `/status`、`/debug-config`、`/subagents` 確認配置生效（不可拿當前配置會話充當已生效證據）。
5. 視環境許可執行一次低風險唯讀派發測試（如 `search`／`grep`、`audit` 與簡短的 `advisor` 核實）；若因權限、額度或非互動環境無法直接派發，明確標註「配置與 TOML/CLI 校驗已通過，實際派發待新會話驗證」，不可捏造執行紀錄。
6. 依第 5 節格式輸出完整報告與一鍵還原指令。

---

### 5. 驗收條件、反模式與交付報告格式

#### 驗收清單
- [ ] 套用於正確的 `$CODEX_HOME`，並已盤點既有設定與 `models_cache.json`。
- [ ] 取得使用者明確批准前未進行任何寫入或安裝。
- [ ] 主代理與四個子代理（`search`、`grep`、`audit`、`advisor`）模型與推理強度一致，無未核實或不存在的模型 ID。
- [ ] 所有 TOML 皆通過標準解析器與 `codex --strict-config doctor` 檢驗，無轉義殘留。
- [ ] 所有既有 MCP、外掛、沙盒、核准政策與全域規則完整保留。
- [ ] `AGENTS.md` 專用標記區塊僅存在一份。
- [ ] 明確回報備份位置與一鍵還原方式。

#### 明確禁止（反模式）
- 禁止把每個微小查詢都委派給 `search`／`grep`，或每次小修改都自動觸發 `advisor` 消耗額度。
- 禁止讓唯讀子代理在缺乏證據下作武斷結論，或讓多個代理同時寫入同一份原始碼。
- 禁止由主代理口頭宣稱「已按顧問標準審核」冒充真正的 `advisor` 子代理回應。
- 禁止寫入未經核實的配置鍵（如舊版 `[agents]` 中的 `enabled = true`）或不存在的模型名稱（如 `gpt-6.2-terra`）。
- 禁止將 `AGENTS.md` 行為規範宣稱為真正的系統級 Sandbox 隔離。

<details>
<summary><strong>展開檢視：交付時 Codex 應輸出的標準報告格式</strong></summary>

```text
Codex 多模型子代理配置報告

階段：Phase A 預覽 / Phase B 已套用 / Phase C 已驗證
環境：作業系統、Codex 版本、CODEX_HOME
現況：原主模型、multi_agent 狀態、既有設定衝突與處理方式

變更清單：
- 新增：...
- 修改：...
- 保留未變：...

變更 Diff：
（完整 Unified Diff；若過長請分段清楚呈現）

驗證：
- TOML 語法解析 (tomllib)：PASS / FAIL / NOT_RUN
- CLI 嚴格配置檢查 (codex --strict-config doctor)：PASS / FAIL / NOT_RUN
- 模型目錄核實 (models_cache.json / debug models)：PASS / FAIL / NOT_RUN
- Sol 主代理 (gpt-6.2-sol / xhigh)：PASS / FAIL / NOT_RUN
- Luna search / grep (gpt-6-luna / xhigh)：PASS / FAIL / NOT_RUN
- Terra audit (gpt-6.1-terra / xhigh)：PASS / FAIL / NOT_RUN
- Astra advisor (gpt-6.2-astra / xhigh)：PASS / FAIL / NOT_RUN

備份／還原命令：...
限制與待處理事項：...
下一步：等待批准 / 完成 / 需人工處理
```

</details>

---

## 版本更新摘要

- **`v0.3.2`（目前版本）**
  - 完成終端機 **TUI 數據流介面**重構：保留點陣框線、動態正交數據連線與光點動畫，並新增「對話（Session）／輪次（Turn）」統計範圍切換與「精簡隱藏」模式。
  - 統一文件與外掛／多子代理角色命名對照，移除本機絕對路徑並整理為 GitHub 公開發佈版本。
- **`v0.3.0`**
  - 修復「Codex Workflow 已逾時」問題：改用字面切片取代 `String.prototype.replace` 注入 `dist/bridge.js`，根除套件內 `` $` `` / `$&` 造成腳本截斷的錯誤，並加上 `--minify` 壓縮與強化握手流程。
  - 導入 Node 內建唯讀 `node:sqlite` 直接觀測 `$CODEX_HOME` 狀態資料庫與 `rollout-*.jsonl` 尾端中繼資料，實現單模型與多子代理皆免手動配 Hook 即開即用。
  - 實作三態發光邏輯與外掛自身輪詢過濾。

---

## 授權與作者

- **授權條款**：[MIT License](./LICENSE)
- **作者**：Baiming & GPT & Gemini

---

## 官方參考資料

> 若官方文件與本儲存庫規格有差異，請以本機 `codex` 執行檔實測及官方最新文件為準。

- Codex Subagents 與 Custom Agents：<https://learn.chatgpt.com/docs/agent-configuration/subagents>
- Codex Config Reference：<https://learn.chatgpt.com/docs/config-file/config-reference>
- Codex Config Basics：<https://learn.chatgpt.com/docs/config-file/config-basic>
- Codex CLI Reference：<https://learn.chatgpt.com/docs/cli/reference>
- Codex Developer Settings：<https://learn.chatgpt.com/docs/developer-settings>
- OpenAI Model Catalog：<https://developers.openai.com/api/docs/models>
