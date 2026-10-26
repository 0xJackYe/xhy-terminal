# XHY 安全卫士（Windows CMD）

双击项目根目录的 **启动安全卫士.bat**，输入 `1` 开始全盘扫描。也可以在本目录的上一级执行 `python -m security_guard`。需要 Windows 10/11、Python 3.9 或更高版本，以及可用的 Microsoft Defender；无需安装第三方 Python 包。

界面为中文 CMD 菜单。程序会让 AI 说明这个文件是什么、主要用途、可能来源、实际读到的内容行为、删除影响以及分析局限，之后再给出风险建议。菜单 `7`“AI 分析这个文件是什么”也能单独解释一个没有被标为可疑的文件。AI 倾向低风险时保留文件并记入报告；高风险、引擎检出及证据不足的项目会显示 Windows 确认弹窗。选择【是】只在资源管理器中定位文件，之后由你亲手处理、删除；选择【否】保留文件。默认选项为【否】。程序没有删除、隔离或执行被扫描文件的功能。

## 扫描方式

第一阶段遍历指定范围内的所有可读取常规文件，完整流式读取并计算 SHA-256；对双扩展名、文件名方向控制符、格式伪装和组合脚本行为筛选可疑候选。对脚本和 PE 文件在本机提取静态证据，包括真实格式、大小、采样熵、脚本能力类别、PE 节数及导入 API 能力类别；新增防护规避与持久化等能力组合的候选规则。采样内容仅限前 256 KiB，其余内容仍参与哈希；高熵或某项 API 能力本身都不等于恶意行为。普通可执行文件或单个管理命令不会仅因类型而被判断为病毒。

第二阶段调用系统 Defender 病毒库，以自定义扫描并强制附加 `-DisableRemediation`。按微软说明，这种模式不对检测应用处置，扫描压缩包且忽略文件排除列表，检测通过命令输出返回。程序不修改 Defender 设置；返回码 2 同时可能表示扫描错误，因此不会直接把它当成病毒。

可疑候选在弹窗之前自动交给 DeepSeek `deepseek-flash` 分析，通常每 4 项一批；不足一批会在约 30 秒后的下一个文件处理点或当前扫描阶段结束时提交。全部候选持续分批处理，没有只分析前 20 项的总限制。现在会发送经过脱敏的文件名、技术目录上下文、文件属性、签名验证结果和版本描述，而不是只有匿名风险标签；完整私人路径仍不发送。AI 必须分别解释文件类型、用途、可能来源、所见行为、删除影响和分析局限，不允许只返回“证据不足”。无法确认来源时必须说明无法确认，不能仅凭文件名冒充已验证的系统文件。

脚本或文本可在允许后发送最多 6000 字符、12 KiB 的脱敏内容片段，帮助 AI 分析具体逻辑；PE 可发送有限的可打印字符串，并明确标为静态字符串，不是已经执行过的行为。默认只对在系统/程序目录且本机签名验证有效的微软文件自动分享片段；其他可分析文件会先询问是否允许发送内容到 `api.deepseek.com`，拒绝则只按属性解释。私钥、密钥库、钱包、凭据配置、数据库及常见私人办公文档等不发送正文。脱敏会遮盖可识别的 API key、密码、访问令牌、邮箱、用户目录及长编码值，但不能保证消除所有私人信息。

`--share-content` 表示你允许本次运行发送上述有限脱敏片段，敏感类型仍阻止；`--metadata-only` 表示一律不发送内容片段，也不弹出内容分享询问。说明文件的入口不需要该文件先命中风险规则；单独说明按有限采样读取，不为了说明大文件先完整哈希。程序不打开运行任何被分析文件，不执行模型返回的命令。

风险结论分为“Defender 已检出威胁”“AI 判断高风险/可疑”“AI 倾向低风险，建议保留”“证据不足”。即使风险无法确定，也会尽可能解释文件本身。AI 的高风险判断不会被描述为病毒确诊，文件名、哈希、熵、未签名或单项能力不能单独证明感染。没有实际联网查询哈希情报；签名验证不可用或未签名时会明确显示。版本属性可能伪造，不能替代有效签名。AI 不能将 Defender 检测降为低风险，AI 低风险也不意味着文件绝对安全。AI 复核失败时保留本地结果并标为未完成，当前运行不再反复请求失败的服务。

调用会消耗 DeepSeek 账户额度，次数随候选数量增加；本地文件读取与 Defender 扫描不消耗 DeepSeek Token。报告累计记录实际 API 请求次数和输入、输出、总 Token。API 未返回有效用量时明确标记统计不完整，不能把缺失用量算作实际零消耗。

全盘指已分配盘符的本地固定盘和已挂载可移动盘，本机当前能识别 C、D 盘。网络盘、光驱和仅通过目录挂载的卷不自动扫描。目录联接、符号链接、其他重解析点、离线云文件、权限不足或读取期间变化的文件会被跳过或标记错误，并记录具体原因。不会为扫描下载云端文件、修改权限或取得文件所有权。NTFS 备用数据流、内存、固件和实时行为不属于本工具的本地规则扫描范围；加密压缩包等内容受 Defender 自身能力限制。

**本程序不保证绝对无病毒。Windows 或其他杀毒软件的实时防护仍独立运行，可能按原有设置处置其检测；程序不关闭这些保护。** 如需更多系统文件权限，可右键启动脚本选择“以管理员身份运行”，程序不会自动提权。

## CMD 命令

以下命令在项目根目录运行：

```bat
python -m security_guard
python -m security_guard --all
python -m security_guard --scan "D:\Downloads"
python -m security_guard --scan "C:\Users\your-name\Downloads" --scan "D:\Tools"
python -m security_guard --status
python -m security_guard --check-api
python -m security_guard --configure-key
python -m security_guard --review
python -m security_guard --analyze "D:\Tools\example.exe"
python -m security_guard --analyze "D:\Tools\example.ps1" --share-content
python -m security_guard --analyze "D:\Tools\example.ps1" --metadata-only
python -m security_guard --scan "D:\Downloads" --no-ai
python -m security_guard --scan "D:\Downloads" --local-only --no-ai
```

`--no-ai` 禁止向 DeepSeek 发送扫描复核；`--local-only` 只做本地规则检查，**没有病毒库结论**。这两个选项也适用于交互菜单。可用 `--model 模型名称` 切换账户支持的模型。`--check-api` 仅查询模型列表，不调用付费聊天生成接口。

扫描时按 Ctrl+C 会停止等待并保存已获得结果。取消 Defender 子进程后，系统 Defender 服务可能继续完成已提交的无处置扫描。菜单模式下停止扫描后返回菜单；输入 `0` 退出。

## 密钥与报告

密钥用当前 Windows 用户的 DPAPI 加密，保存在 `.local/security-guard/deepseek-key.dpapi`；不会明文写入源代码。更换密钥时选择菜单 `5`，输入过程隐藏。环境变量 `DEEPSEEK_API_KEY` 优先于本机配置，设置了该变量时需同时更新它。加密配置无法直接复制给其他 Windows 用户使用。

每次扫描在 `.local/security-guard/reports/日期-编号/` 生成：

- `report.json`：范围、运行进度、完成状态、分类计数、引擎结论、AI 请求次数与实际 Token 用量，最多附带前 1000 项摘要。`explanation` 为六部分文件说明，`identity` 为文件属性与内容分享状态，`verdict` 为风险建议。
- `文件说明.txt`：可以直接阅读的中文文件说明，包含用途、来源、内容、删除影响、风险及建议。
- `findings.jsonl`：全部发现、自动结论和用户确认选择；每批完整的 `analysis` 自动判断保存之后才会弹窗，避免关闭第一个弹窗时丢失该批其他判断。
- `skipped.jsonl`：跳过或无法读取的范围；如无跳过则可能不生成。
- `defender.log`：按 JSON 行存储原始引擎输出片段，保留输出中的换行。仅本地扫描不会生成。

API 编号仅在每个批次内使用；完整结果通过路径、来源与检测依据关联，见 `findings.jsonl` 中 `finding` 与 `analysis` 条目。`report.json` 的 `ai.usage` 包含累计输入、输出、总 Token，`ai.usage_complete` 表示统计是否完整。Defender 未解析具体文件时，条目的 `source` 为 `defender_unresolved`，`path` 留空，不把扫描目录伪装成受感染文件。

报告保存文件属性和 AI 说明，不保存发送过的原始内容片段；AI 说明可能包含片段的概述。读取时检查链接、占位符和文件变化，最多 8 MiB 的已有扫描哈希会完整复核；大文件会明确标注哈希未重新完整验证。获取 Windows 签名和版本属性失败时不会伪造发布者。

可通过菜单 `6` 或 `--review` 查看已保存的自动结论并重新确认需要处理的项目，不会重复发起 AI 请求。查看指定报告可用 `--review "完整报告目录或 report.json 路径"`。权限不足、扫描错误、跳过范围和取消都会显示覆盖不完整，不能作为“全盘安全”的结论。程序自身正在写入的报告单独记为预期排除，不计入用户文件的读取失败。报告含本机文件路径，请在分享前自行检查隐私。整个 `.local/` 已由项目 `.gitignore` 忽略。

一次性命令退出码：`0` 扫描结束且没有发现；`1` 有需要人工检查的项目；`2` 存在未完成范围或运行错误；`130` 用户中止。若同时发现项目并有未完成范围，返回 `2`，具体发现仍保存。

## 验证

```bat
python -m unittest discover -s security_guard -p "test_*.py" -v
```

测试使用无害文件、模拟引擎和模拟弹窗，不生成病毒样本，不修改防护设置，也不清理用户文件。DPAPI 测试只使用占位密钥。

接口依据：[Microsoft Defender 命令说明](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus)、[DeepSeek 模型接口](https://api-docs.deepseek.com/api/list-models/)、[DeepSeek 聊天接口](https://api-docs.deepseek.com/api/create-chat-completion/)。
