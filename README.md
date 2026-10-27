# XHY Terminal

个人本机总终端，整合饮食日记、加密资产、比特币价格警报，并提供 Windows CMD 界面。

## 代码结构

- 根目录及 `frontend/`：统一网页、深浅主题、北京/GMT 时钟、服务代理及命令行终端。
- `apps/diet/`：饮食日记、按日期查看、折叠餐食、DeepSeek 自然语言查询及修改。日记日期按 UTC+0 划分（北京时间 08:00 换日），跨北京时间零点的夜班记在同一天；时钟、警报时间和比特币当日涨跌仍用北京时间。已有记录的日期保持不变。
- `apps/bitcoin/`：欧易/币安只读账户查询、离线钱包、价格警报、定投成本和长期持仓浮盈。
- `security_guard/`：本机安全卫士的命令行源码。
- `configs/api-credentials.json`：按仓库所有者明确要求，包含明文欧易、币安及 DeepSeek API 配置。仓库为私有。

## 当前持仓功能

只展示持仓平均买入价、当前 BTC/USDT 价格、浮盈和收益率。每笔定投按实际净到账 BTC 与含手续费支出自动更新移动加权平均成本；后台每 20 秒核算，页面每 30 秒刷新。历史卖出只调整剩余持仓成本。跨币种买入按成交分钟行情折算，计算假设在页面可展开查看。

## 本机运行

需要 Windows、Python 3.9+、Node.js 20+，比特币后台依赖见 `apps/bitcoin/requirements.txt`。

```powershell
python -m pip install -r apps/bitcoin/requirements.txt
python restore_api_credentials.py
$env:XHY_DIET_ROOT = Join-Path $PWD 'apps/diet'
$env:XHY_OPTIONS_ROOT = Join-Path $PWD 'apps/bitcoin'
python launch.py
```

总终端默认地址为 http://127.0.0.1:8780/；饮食和比特币后台分别使用 4173、8766。CMD 使用 `python cli.py`，或双击原有启动脚本。上述环境变量让启动器使用仓库内的两个子项目。

## 手机界面

打开页面时自动识别设备：手机（iPhone、Android 手机，或短边小于 600px 的触屏设备）显示手机界面，包括大标题、可横向滑动的时间条、底部悬浮标签栏和底部弹出的连接详情；电脑和 iPad 显示桌面界面。连接详情里的“界面”可切换为自动、手机或电脑，选择保存在当前浏览器；也可以在地址后加 `?ui=mobile`、`?ui=desktop` 或 `?ui=auto`。添加到 iPhone 主屏幕后以全屏方式打开。

## 实时行情与快捷操作

- 总览页的比特币价格、当日涨跌、区间和走势末端每秒随行情更新，卡片标题旁显示“实时”，浏览器标签页标题同步显示价格。数据流只含行情、警报设置和最近警报，不含整日走势（约 1 KB/秒）；离开总览或标签页隐藏 5 分钟后断开，回来自动重连。比特币终端自身的数据流在走势不变时只发送最新的点。
- 电脑上按 ⌘K / Ctrl+K（或 `/`、`?`）打开命令面板，可按中文、英文或拼音首字母搜索页面和操作；`1` `2` `3` 切换页面，`R` 刷新总览，`T` 切换明暗。焦点在饮食日记或加密资产页面内时同样有效，输入文字时不触发。连接详情底部列出这些按键。
- 饮食日记或比特币终端未运行时，总览顶部和对应页面显示“启动服务”按钮，一键在本机启动，恢复后页面自动重新加载。

## 公开演示站点（Cloudflare Pages）

`frontend/` 同时部署为公开演示站点 https://xhy.pages.dev/ 。Cloudflare 项目已连接本仓库：推送到 `main` 即更新正式站点，其他分支生成预览地址。

- Cloudflare 项目设置：框架预设 None，构建命令留空，**构建输出目录必须是 `frontend`**。不可设为仓库根目录，否则 `configs/` 中的明文 API 配置会被公开。
- 不在 127.0.0.1 / localhost 打开时，总览使用 `frontend/demo.js` 的示例数据并标注“演示数据”；饮食日记和加密资产只在本机运行，公开站点只显示说明。
- `.github/workflows/deploy-pages.yml` 是另一种部署方式（wrangler 直传），只有在仓库 Secrets 中设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 时才会执行；使用 Cloudflare 的 Git 连接时无需设置。

## 数据单独恢复

这是源码和 API 配置备份。实际饮食日记、钱包快照、账户流水、成本账本、报警设置、日志及截图没有提交，原电脑上的数据没有修改。

- 饮食：从原项目恢复 `data/diary.json` 及需要的 `.local/runtime-diary.json`。新建空日记可复制 `apps/diet/data/diary.example.json` 为 `diary.json`。
- 比特币：从原项目恢复 `terminal/data/`，特别是 `bitcoin-balance-snapshot.json` 和 `bitcoin-cny-rates.json`；在 `apps/bitcoin/` 内运行 `node terminal/wallet/build_wallet.mjs` 重新生成余额页面。生成页含私人快照，因此不纳入 Git。
- DPAPI 受保护的账本与凭据绑定 Windows 用户。跨电脑时可用本仓库的明文 API 配置重新写入凭据，历史账本仍需按原导入流程恢复，不会伪造历史成本。
- 邮件凭据没有包含；如需邮件通知，在本机页面重新配置。

`restore_api_credentials.py` 只把本仓库的 API 配置导入仓库内比特币项目的本机加密存储；已有凭据不会覆盖，不调用交易或转账接口。

## 验证

```powershell
python -m unittest test_server test_cli -q
cd apps/bitcoin
python -m unittest test_btc_pnl_service test_btc_cost_tracker test_btc_cost_http test_btc_terminal_server test_combined_wallet_service -q
node test_terminal_frontend.js
node --test test_terminal_ui.js
node test_combined_wallet_ui.js
```

饮食项目可运行 `npm run check`、`npm test`、`npm run build`。部分原始日记归档检查需先恢复本机日记数据；日常测试不调用付费 AI 或交易接口。

原有 Diet 和 Portfolio 仓库未改动。此仓库保存的是三个本机项目当前代码的整合快照。
