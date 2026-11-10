# Echo 验收记录

## 0.16.2 邮件提醒

- `pnpm verify` 通过 330 项测试，以及类型、翻译和生产构建检查。
- 回归覆盖共享规则的顺序、提醒结果、角色邮箱授权、Review 选源、通知去重和历史邮件游标。验证使用隔离数据库和合成邮件。

## 0.16.1 多角色桌宠、子任务授权与完整示例

- `pnpm verify`：329 项测试、类型和翻译校验、生产构建通过；原生模块 21 项、桌面壳 1 项测试通过。
- 每个观察任务支持 1、4、9 张真实帧，默认四张；未完成组图默认 120 秒过期。测试覆盖遮挡空档仍过期、旧帧清除、静止画面恢复、五秒选帧限制、真实时间戳、三种拼图布局和旧配置的只读默认值。
- Hina、Miyu 的人设、各渠道表达、主动交流、观察、记忆整理、关注整理与委派指引分别配置。示例启用通用功能；外部账号与屏幕授权仍需用户配置。更新示例是显式操作，保留会话、记忆、角色活跃状态和现有共享向量模型。
- 客户端内置 BGE Small 中文 Q8，采用固定上游版本和 SHA-256 校验。隔离测试在空缓存、禁止下载的情况下产生 512 维向量，两组合成语义配对通过；这不是大规模召回质量评估。
- 角色只配置子任务授权上限，每次委派直接选择本次执行设置，不再要求添加可复用的执行者配置。新增目录、模型、应用工具、终端及时限越权测试；分别验证子会话工具隔离与历史配置只读兼容。中文审批选项不再显示内部枚举值。
- 两只真实原生桌宠同时运行，验证独立窗口、气泡、输入会话和角色启停；测试调用合成模型，不调用外部 API。素材逐帧校验排除了 Hina、Miyu 的末尾透明填充帧；PetDex 导入保留有意的中间空帧并修剪末尾填充。

## 0.16.0 任务输出与发布准备

- `pnpm verify`：316 项测试、类型和翻译校验、生产构建通过；原生桌宠 20 项、桌面壳 1 项测试通过。启动迁移额外检查原始任务配置与界面派生字段隔离，保留动态避让规则和原任务模式。
- 观察、主动交流、记忆整理和邮件触发任务分别配置输出位置。新增输出注册、单次推理多目标投递、失败渠道独立重试、未知结果禁止重放、目标变更隔离、报告不进入推理上下文和回执结束跟进的回归。
- 记忆整理启动时冻结报告目标，目标绑定发生变化后不转发旧结果。任务输出与历史通过索引查询，输出管理本身不添加轮询定时器。
- 三组隔离界面验收覆盖任务级渠道选择、仅外部展示、结果回执、自动化与委派任务分开、示例角色启停以及原有模型/角色编辑流程。均未调用真实模型或发送真实 QQ。
- 发布目录采用明确清单；增加本机私有角色文本/素材指纹比较。审计报告不包含参考文本或匹配内容。手动 GitHub 构建工作流只生成产物，不自动创建或发布 Release。
- `scripts/installer-smoke.ps1` 的隔离安装、0.15.0 → 0.16.0 升级、卸载与数据保留验收通过，未调用真实模型。打包后的 Agent 能调用原生文件工具并完成同一会话续推理。安装测试使用独立数据目录；不代表已穷举所有 Windows 环境。
- 安装版后端的 5 秒空闲样本为约 105 MiB 工作集，单核 CPU 样本为 0%；没有加载模型或桌面 WebView，不能当作完整应用的资源占用或长期性能结论。

## 0.15.0 角色活跃状态与示例

- `pnpm verify`：306 项测试、类型与翻译校验、生产前端构建通过。新增总开关、停用后迟到结果隔离、排队输入与气泡作废、渠道输入去重、观察停止和记忆整理检查点恢复；原生桌宠 20 项、桌面壳 1 项测试通过。
- 两位示例角色与群聊在临时数据目录中创建；无模型调用、无屏幕采集、无外部消息。角色包导出/导入保持任务模式、允许的记忆操作和素材署名来源。
- `starter-ui-smoke.ts` 验证示例创建、角色启停、重新打开页面的状态保持、输入禁用、群聊成员入口，0 前端异常；`product-ui-smoke.ts` 验证既有角色编辑、模型选择与插件设置流程，0 模型请求。
- 本轮行为测试使用本地模型桩，不能据此承诺所有第三方模型服务可用。安装包、便携版与源码包在本机生成；不自动发布或上传。

## 0.9.0 DSH 接口与设置层级修复

- `pnpm verify` 216 项测试通过，类型、翻译与生产构建通过；原生组件 17 项测试通过。新增角色记忆向量隔离、共享知识索引不受角色选择影响、增强卸载后关键词召回、解析凭据状态、自动化配置归属及连接检查采用已有模型的回归。
- 已安装的 DSH 0.2.2-rc.1 在隔离 Home 中通过 Responses 原生验收，provider 使用 `openai`；前序同轮还验证了 `custom` 下的 Responses 与 Chat Completions。人格、记忆召回、续聊、Review 与 Echo MCP 工具走通。Responses 额外检查逐轮 off 及 xhigh 映射 high 的请求内容。每组四次本机模拟请求，真实收费调用为零。
- 不改用户 DSH 本体或桌面配置。自定义接入使用 DSH 官方插件管理器，在 Echo 隔离 profile 中加载与宿主版本匹配的适配器。此验收证明当前宿主与模拟协议可用，不代表已经对真实付费上游完成生成测试。
- 自动化任务描述显式声明配置作用域；角色任务的运行页只展示状态，角色编辑流程负责配置。Observe 页面移除第二份不可达的编辑表单，并按任务 ID 读取最新配置和近期记录。
- 两组浏览器流程通过：角色创建与编辑、Codex 切换 DSH、桌宠帧率保存、独立设置窗口；角色任务运行页无重复编辑入口、共享推理模型选择位于对应插件设置中、Observe 运行页与配置分离、JPEG 质量和遮挡豁免字段可见、MinerU 连接与导入选择分离。新增界面流程未调用模型。

## 0.9.0 主动策略与配置归属

- `pnpm verify` 195 项测试通过，类型、翻译及生产构建通过；原生组件 14 项测试通过，桌面壳编译和测试目标通过（壳内无独立单元测试）。角色创建/编辑、群聊、执行工作台与本轮配置归属的三组浏览器流程通过，使用隔离数据和本地模型桩。
- 新回归覆盖每日概率额度、错过概率不调用模型、同时间段不重复抽签、跨插件重载的每日上限、既有执行计数超出历史显示窗口、跨会话真人活动与可选观察避让。
- 邮件回归使用假 IMAP 元数据和本地模型桩，覆盖首次同步/历史回填/UID 变化不触发、关键词与排除条件、程序通知防重、当前游标起步、未知推理不重放、通知提供方晚到和暂停。
- “在意的事”迁移保留正文及历史；普通记忆保留原位。Review 支持有版本检查的新增、修订和淡出。
- 浏览器流程检查记忆页并列入口、无任务状态、主界面通用日历、仅通用设置、角色推理用途不在公共路由中、设置返回工作台及概率表单。测试不使用真实邮件、付费模型或 QQ。
- 补充角色生命周期回归：重现创建/保存角色结束后桌宠未恢复的问题，修复完成状态的订阅；关闭角色桌宠能力后仍停用，卸载插件后不残留角色监听。此单元测试模拟窗口呈现，保留真实插件事件和原生更新队列。

设计与限制见 [主动交流与当前关注](PROACTIVE.md)。

## 0.8.1 角色运行配置入口

- `pnpm verify` 181 项测试通过，类型、翻译及生产构建通过。
- 角色主会话、群聊成员与 Worker 不再通过聊天操作接口直接换后端或权限；主角色在编辑角色中设置，Worker 在其模板中设置。独立核心会话保留独立配置，Persona 仍是可选插件。
- 回归覆盖直接接口绕过被拒、正常角色编辑可切换后端、原连接可恢复，以及主会话运行时保存角色不会先写入新权限或人设。思考强度与实际审批仍可在会话中操作。

## 0.8.0 执行工作台、Worker 与群聊上下文

- `pnpm verify` 通过：179 项测试全部成功，类型、翻译及生产构建通过。
- Codex 官方 App Server 和已安装 DSH SDK 的独立 Home 验收通过：人格注入、自动召回、同会话续聊、Review 和 Echo 工具接入。使用本地合成模型端点，付费调用为零；不证明所有线上模型和后续宿主版本表现相同。
- Pi 使用真实 Agent Core 和官方终端工具，隔离项目中的无害 PowerShell 命令经一次明确审批后执行；没有把工作目录宣称为终端沙箱。
- 新回归覆盖运行中补充指令及未知投递防重、结构化执行记录上限、附件隔离及备份、DSH 子会话归属、Worker 自动接棒与独立验收、并发写入与续接冲突、角色包嵌套资源剔除，以及群聊中途到达的新消息游标。
- 浏览器验收通过角色创建与同配置编辑、群聊回应、独立设置窗口、附件上传、执行过程、运行中补充指令、手动委派与验收。未用生产会话发送测试消息。
- 执行详情折叠时按需读取，事件合并每 120 ms 一次；Worker 完成后事件驱动接棒，没有模型轮询。Pi 终端包仅在启用终端并执行时加载。本轮未重新测量全天资源占用，不把旧版本的短样本当作新版测量。

具体行为及边界见 [执行工作台](EXECUTION.md)。

## 0.7.0 角色工作台

- `pnpm verify` 通过；补齐桌宠配置回归后，167 项测试全部成功，TypeScript、翻译检查及生产构建通过。
- 原生 Rust 模块 14 项测试通过；Tauri 桌面测试目标编译运行通过，没有独立单元用例。
- `scripts/character-ui-smoke.ts` 实际走通创建、同配置编辑、唯一主会话、群聊作者归属及独立设置窗口。
- `scripts/character-desktop-smoke.ts` 使用打包后的 Tauri 程序，验证独立设置窗口打开、复用、关闭，关闭设置后主会话仍能通过本机合成 API 回复。
- 角色测试覆盖素材包导入与更新、跨插件任务归属、撤销能力、续跑授权变化、群聊中断恢复、请求防重及 MCP 委派授权。

这些验收使用临时数据与本机合成推理端点，没有付费模型调用或真实 QQ 测试消息。任务委派保存目标、检查点和结果，不宣称能在不同宿主间迁移原生工具执行栈。

## 0.5.1 历史验收

测试使用隔离临时数据、合成模型端点及自有测试窗口，不调用付费模型，不发送真实测试 QQ 或邮件，不修改现有 Harness 配置。

| 检查              | 结果                                                                         | 证据范围                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript 回归   | 151 项通过                                                                   | 权限、生命周期、队列、未知结果、记忆与 Review、邮件、知识、库归属、显式向量任务、分格式素材导入、Codex 思考协商与错误回执                                                      |
| Rust 原生测试     | 8 项通过                                                                     | 遮挡裁剪、域名边界                                                                                                                        |
| 工作台布局        | 23 页 × 2 种语言 × 2 种宽度，加上推理模型、路由、文档解析子页，共 104 组通过 | 1440 / 900 宽，无页面横向溢出，零浏览器错误                                                                                                                                              |
| 实际界面流程      | 通过                                                                         | 会话删除取消/执行、未保存保护、主题持久化、格内输入与 Enter 连续录入、时间轴、角色想法、邮箱预设、素材预览与文件列表                                                     |
| 邮件协议与审批    | 通过                                                                         | 本地假 IMAP/SMTP 与 HTTP CONNECT、按账户选择直连/代理、代理失败不回落直连、收件/发件文件夹、UID 检查点、文件夹读取失败及取消不阻断未来同步、冻结草稿与批量整理、逐项回执、未知结果不重放 |
| 知识维护          | 通过                                                                         | 批量冲突整体回滚、范围内检索、可恢复解析、同原件路径修复、归档/恢复/删除及原件保留                                                                                                       |
| 主观想法          | 通过                                                                         | 按角色隔离、普通会话注入、Review 修订/解决/归档、冻结版本与防重复提交、提供方卸载                                                                                                        |
| 每日整理          | 通过                                                                         | 覆盖当日启动前材料，完整增量分段和来源检查，检查点续跑，完成后提交，一次兜底与一次完成报告                                                                                               |
| 原生桌宠与气泡    | 通过                                                                         | 真实发布版资源布局、帧动画、shown 回执、同会话回复、关闭管理窗口释放 WebView、重复启动不创建第二套实例                                                                 |
| Observe 打包链路  | 实际游戏通过；合成网页复验受限                                               | 关闭性能叠层后，指定白名单游戏连续完成四帧识别。隔离网页场景只采到两帧，后续被白名单可见性判定拒绝，未完成该场景的全链路验收。                                                           |
| 空白发布包        | 通过                                                                         | 无用户后端、记忆或会话，采集和自动动作关闭                                                                                                                                               |

DSH 官方 SDK 与 Codex 官方 App Server 的先前真实宿主协议验收使用独立 Home，覆盖人格、召回、原生助手、恢复同会话与 Review；本次回归继续通过其合成协议测试。宿主型号、授权套餐及后续版本需分别验证，协议测试不证明所有提供方的实际输出质量。

## 资源样本

同一台 16 逻辑处理器机器，每组约 16.7 秒。工作集相加重复计算共享 DLL，不能视作独占物理内存；同时记录私有工作集与私有提交量。以下为合成验收实例，不含活动模型或视频捕获。

| 模式                           | 进程 | 工作集相加 | 私有工作集 | 私有提交量 | 整机 CPU |
| ------------------------------ | ---: | ---------: | ---------: | ---------: | -------: |
| 管理窗口与基础桌宠             |   10 |  580.9 MiB |  184.1 MiB |  360.4 MiB |  0.0407% |
| 关闭管理窗口，仅基础桌宠与核心 |    4 |  181.1 MiB |   60.6 MiB |  106.8 MiB |  0.0059% |

早期浏览器桌宠样本约 559 MiB 工作集。原生基础桌宠样本约少 68%；主要来自移除桌宠 WebView，关闭管理窗口另释放浏览器进程。此比例不是全天或所有设备的承诺。新的专业工作页面按需加载，入口脚本从约 563 KB 降到 456 KB（约 19%），这不等价于常驻内存同比下降。

解析与导出 Worker 按需启动，普通文档串行处理。知识页面通过事件更新，无固定轮询。向量 Worker 和闲置 Codex 宿主在无任务两分钟后释放。活动模型、图像编码和本地推理的额外占用另计。

0.4.0 的检索增强保留语义与混合检索，向量任务支持暂停和续建。模型常驻是单独选项：开启后仍等首次使用才加载，之后保留至停用/退出，切换 API 会释放空闲本地模型。现有离线 BGE Q8 的两条合成记录测试，首次加载和查询约 1389 ms，重复查询 4.7 / 5.0 ms；加载期间进程 RSS 增加约 220 MiB，不能把这个增量理解为整个桌面应用的内存。另一次离线质量复测 8/8 正例首位命中、2/2 负例为空，未调用线上模型。

647 篇现有长文献的关键词检索试跑促成了 SQLite FTS 候选筛选，热查询样本约 757–780 ms。首次建立全文索引样本约 4480 ms、临时 RSS 增加约 321 MiB；不能把索引创建开销当成常驻负担。语义和混合策略仍可显式选择，不因本地全文索引而移除。

新增界面验收覆盖：切换库时目录树与选择重置、目录展开/全部收起、关键词/语义/混合选项、单独向量索引入口、托管库禁止通用导入、桌宠素材导入后预览但不自动应用，以及 MCP 保存区间距。

0.4.1 全插件审计覆盖 24 个包、144 项操作、135 处静态页面调用、55 个配置字段和 23 页归属，未发现缺失调用、无效配置选项或权限归属冲突。重复启停全部插件后，无残留操作/提供项、时钟任务或事件监听。此检查结合已有调用中断、加载失败撤回、版本冻结和可选来源消失测试，不等于每个动态 CRUD 响应都具有精确类型，详见 [Plugin architecture](PLUGINS.md)。

本轮实际页面流程额外验证帧素材导入、渲染预览和选择。语义增强停用时当前检索切回关键词，重新启用恢复可选能力。原生窗口测试验证人物类没有矩形卡片阴影，气泡/编辑器保持独立样式；继续验证输入法、失焦取消、回车单发及宿主恢复不重播。

额外修复并验证 Files 写入跨越停用/重新启用时的实例代际检查，以及 Media Assets 停用时未完成导入的登记取消。文件注册/写入在异步阶段后重新检查实例；图片素材提交前检查取消信号。中止可能留下已写出的不可变对象或临时文件，但旧实例不能在新实例中提交新的文件记录，素材插件也不能补登记迟到结果。素材卡片改为内容撑高，并检测图片/导入控件不越出卡片边界。

## 边界

- 未穷举独占全屏、受保护视频、HDR、多显示器、全部输入法和浏览器版本。
- BGE 中文 Q8 的既有小样本：8 个合成正例 Top-1/Top-3 均为 8/8，2 个负例为空；其他模型和真实大库不据此保证同样质量。
- 未进行数年数据、多设备并发或 24 小时持续压力测试；这是单设备单写者应用。
- 具体解析、认证和媒体能力边界见 [Feature coverage](FEATURES.md)。外部错误和用户内容不自动翻译。

## 复现

```sh
pnpm verify
cargo test --release --lib --manifest-path native/Cargo.toml
pnpm exec tsx scripts/e2e.ts
pnpm desktop:build
pnpm exec tsx scripts/desktop-smoke.ts
```

桌面测试会拒绝向已经运行的 Echo 桌面转发，需先关闭其他 Echo 桌面实例。它只操作自有窗口，生成独立测试数据。测试报告留在开发验收目录，私人运行数据不属于发布输入。

## 0.5.0 推理与检索补充

新增测试覆盖连接与模型分层、插件增量任务、API 向量计数/维度、共享 Codex 登录、本地进程卸载、GGUF 文件身份与路径迁移、原分段索引的范围与过期校验，以及 MinerU 上传、恢复、未知结果保护和媒体保留。界面流程覆盖 GGUF 文件配置、解析提供方切换，配置过程不加载权重。备份使用流式复制与校验，恢复时保留结构向量并解除外部 Harness 原生会话绑定。

实际本地 EmbeddingGemma 2 Q8_0 验证输出 768 维，8 个合成查询 Top-1 为 8/8，含首次加载共约 3.4 秒。它是小样本功能验收，不能代表任意语料召回率。MinerU 使用协议模拟与假本地 CLI 测试，没有上传真实私人文档或调用收费服务。

当前机器的 15 秒空白核心样本约 74 MiB RSS、0.51% 单核 CPU（16 逻辑核折合约 0.032% 总 CPU）。原生窗口样本：关闭管理窗口后，帧动画整套进程约 150 MiB 合计 RSS / 52 MiB 私有工作集；网格动画约 165 / 67 MiB，总 CPU 分别约 0.017% / 0.18%。这是短样本，合计 RSS 包含进程间共享页，不能直接等同实际物理占用。实际用户数据、角色素材及模型会改变这些数值。

## 0.5.1 增量验收

修复进程白名单的完整 EXE 路径与短名称错配；路径规则精确匹配，不因失败退化为同名进程授权。采样暂停原因显示在观察页面，透明叠层仍按安全遮挡处理。关闭性能叠层后，真实游戏已连续完成多组四帧识别。

新增音频/视频原生向量接口、1 fps 视频采样、BGE 与 EmbeddingGemma 2 模板、记忆分类页签、库注册来源显示。隔离回归验证模态开关不改变原有向量空间、原索引别名保留结构证据、媒体协议与生命周期释放。真实模型的音频/视频检查见推理说明。角色优先入口和多任务观察仍在设计阶段，不属于本次已实现功能。

## 0.5.2 角色工作区与观察任务

角色列表先于设定、记忆、想法和桌宠选页。桌宠为每个角色保存设置，桌面显示一个选定角色。观察任务独立设置角色、会话、提示词、白名单和运行状态。任务共享本地采集助手，各自校验屏幕权限、隔离拼图与近期摘要；同一角色共用互动间隔。旧观察迁移保留原白名单、两段提示词、会话及冷却状态。备份恢复会暂停所有观察任务。

视觉模型仅漏回互动标志时，保留有效摘要并按不触发互动处理。互动区分生成回复、明确跳过、空回复与失败，只有实际回复进入气泡队列。当前 Codex App Server 的应用事件作者、会话恢复和回复路径使用本地模拟模型验收。

## 0.5.3 采样暂停状态

预检通过后，正式截图仍可能因授权场景变化被拒。模拟采集器验证了此时显示暂停原因、不登记帧，下一次获准后自动清除原因。遮挡状态与模型或采集故障分开显示，Windows 对透明区域的确认仍是截图授权的前提。

# Ordered context and backend selector regression (2026-11-07)

- `pnpm verify`: 208 tests passed, type/localization checks and production web/server build passed.
- Context tests cover stable/history/turn/request order, optional anchors, cycles,
  plugin unloading, memory version deduplication and explicit-only Knowledge search.
- Backend contracts cover Codex and DSH context acknowledgements and embedded Pi
  message order with a local synthetic API, including tool use. A contributed
  generation adapter also receives reference identity and turn metadata intact.
- `scripts/character-ui-smoke.ts` switches a synthetic character from Codex to DSH,
  opens permissions and saves without a rendering error. Other role editing,
  package roundtrip, historical attachments and group checks passed.
- `scripts/proactive-ui-smoke.ts` passed with zero model calls.
- `scripts/native-sticker-smoke.ts` verified native reply pixels: human/Care image,
  Observe text only, and missing-image text fallback, with zero external calls.
- These are isolated regressions, not new real-provider inference or QQ delivery
  tests. [Model context](CONTEXT.md) documents native history and cache limitations.

## Application and character configuration boundaries (2026-11-07)

- `pnpm verify`: 226 tests passed; TypeScript, locale checks and production web/server build passed.
- `scripts/proactive-ui-smoke.ts` passed with zero model calls. Shared embedding selection is in the Embeddings plugin settings; role editing has no role-specific embedding selector. Role task settings and shared workspace pages remain in their respective configuration areas.
- Memory query planning, semantic query planning and embedding routes are shared application routes. Memory records and recall results remain character-scoped. Knowledge MCP search exposes the application-selected policy; ranking controls stay in the workbench advanced search.
- Legacy role-level retrieval routes and obsolete retrieval settings in character packages are ignored/removed on read or import. The MCP caller's tool permissions remain Harness/application scoped; they are not a per-character ACL.

## Maintainer release commands

Run pnpm release:public in the configured public checkout. It checks the committed
source and every unpublished ancestor, builds and extracts the Windows installer,
then writes the source archive, installer, checksums and a local verification receipt to
dist/release/public/<version>. Use pnpm release:publish from the same clean commit.
It repeats the artifact checks before pushing the public branch and version tag, then
publishes the verified files. Use a new version for each release.

Run pnpm release:private in the configured private checkout. Its portable app and
installer are written to dist/release/private/<version>. The application reads role
configuration, credentials and knowledge from its separate local data directory.

The maintainer policy lives outside both repositories. The default is
~/.echo/echo-release-policy.local.json, with ECHO_RELEASE_POLICY available for a
different location. It specifies both checkout paths, the GitHub repository, absolute
7-Zip and GitHub CLI paths, the private runtime reference, excluded markers and
approved public media hashes. Keep the policy and reference local.
