# Lifetime 交互与导演架构参考

记录日期：2026-10-15。整理前一轮联网讨论，记录研究结论与原始来源。本文是参考笔记，不代表以下能力已经实现，也不要求引入新的框架或 NPC agent。

## 当前目标与研究母题

Lifetime 的目标接近交互叙事（Interactive Narrative）、戏剧管理（Drama Management）与三维行动执行的结合：用户提供灵感，导演制作开场、关键选择节点和近期剧情；玩家调查、对话并作出选择，系统记录实际发生的事情，导演据此继续创作。

近期顺序保持为：先实现 E 调查／E 对话及确定性的事件记录，再接剧情事实、选择后果和导演。NPC 继续使用完整动作之间的简单状态机，地图几何、P 点定位与 NavMesh 留在本地。

## 1. Yarn Spinner：对话内容与游戏执行的连接

Yarn 用脚本表达台词、选项、变量和命令；Dialogue Runner 驱动内容，游戏提供展示、变量存储和命令实现。命令可以等待移动或动画结束后再继续对话。变量持久化与当前对话进度需要明确设计，不能假设对话工具自动保存整个游戏。

Lifetime 可借鉴：将“显示一句话”“提交选择”“调用 NPC 行动”“等待实际完成”分开。E 只打开合适的交互入口；剧情通过受限命令使用现有运动端口。查状态与改状态分开，避免渲染台词时意外执行动作。

不要求现在引入 Yarn 语言或对应引擎插件，先借用其边界设计。

来源：[Dialogue Runner](https://docs.yarnspinner.dev/components/dialogue-runner)、[Variable Storage](https://docs.yarnspinner.dev/components/variable-storage)、[Commands](https://yarnspinner.dev/docs/godot/gdscript/05-connecting-to-your-game/01-commands/)。

## 2. Ink：内容包与游玩状态分离

Ink 将故事编译成可执行内容，宿主程序获取接下来的文本、当前选项并提交选择。运行状态可以独立序列化；通过变量、标签和外部函数与游戏连接。

Lifetime 可借鉴：故事设计包与每一次游玩会话分开保存。导演写入内容版本，玩家选择写入会话。加载游戏不重新生成已经展示的剧情，不重复提交已经执行的选择。调用游戏操作需要清晰的副作用边界。

Ink 本身不负责模型生成、三维寻路或导演续写，这些仍由 Lifetime 实现。

来源：[官方运行集成文档](https://github.com/inkle/ink/blob/master/Documentation/RunningYourInk.md)、[项目介绍](https://www.inklestudios.com/ink/)。

## 3. Storylets：条件、局部内容与后果

Storylet 是带有进入条件和结果的小段内容。系统根据世界事实选择可发生的片段，避免将所有可能性提前铺成庞大分支树。Emily Short 也讨论了基于质量、显著性和关键节点的叙事组织方法。

Lifetime 可借鉴：大纲保留少量关键节点，近期剧情组织为小片段，例如“已调查池塘且尚未询问园丁”解锁一次交谈，完成后记录事实。每个片段有稳定 ID、条件、内容和效果，执行次数明确。

这里引用的是作者的设计文章，不是经实验验证的通用算法。复杂条件和内容冲突仍需本地校验与试玩。

来源：[Storylets: You Want Them](https://emshort.blog/2019/11/29/storylets-you-want-them/)、[Beyond Branching](https://emshort.blog/2016/04/12/beyond-branching-quality-based-and-salience-based-narrative-structures/)。

## 4. Façade：导演、剧情节拍与角色表演分层

Mateas 与 Stern 的《Structuring Content in the Façade Interactive Drama Architecture》（2005）介绍了一部实时交互戏剧：高层戏剧管理器组织剧情节拍，角色行为系统执行大量预先编写的交谈与表演行为。

Lifetime 可借鉴：导演选择“接下来应发生哪段事情”，剧情片段安排交谈和行动，现有动作状态机执行完整行为。剧情节拍应描述戏剧目的，例如“侦探试探园丁”，而不是等同于“走路动画”或一个运动状态。

Façade 依赖大量人工编排内容，不能把它视为自然语言自动生成完整三维游戏已经成熟的证据。

来源：[AAAI 原始论文](https://ojs.aaai.org/index.php/AIIDE/article/view/18722)。

## 5. Drama Llama 与 Dramamancer：受约束的 LLM 交互叙事

**Drama Llama**（2025）让作者设定世界、角色和触发条件，再由 LLM 生成响应并判断触发。它强调让自由生成仍围绕作者的内容意图推进，研究包含早期作者体验反馈。

**Dramamancer** 的设计案例论文（2026）用场景、角色、事件条件和结果组织故事，并区分生成下一段内容与解释玩家输入的模块。它讨论作者意图与玩家能动性之间的设计取舍。

Lifetime 可借鉴：导演输入应包含角色已知信息、已发生事件、当前片段目的和允许的操作。自由文本输入的含义解释与剧情创作可以分开；当前 E 和明确选项的结果直接由本地确定，无需每次询问 LLM。

两者不能替代三维执行验证。文本说“到达桥中央”不代表角色实际到达，剧情必须等待运动执行结果。触发条件也应优先使用可检查的结构化事实，减少每条消息都调用模型判断。

来源：[Drama Llama](https://arxiv.org/abs/2501.09099)、[Dramamancer 设计案例](https://arxiv.org/abs/2601.18785)。

## 6. SayCan：意图与可执行能力结合

《Do As I Can, Not As I Say: Grounding Language in Robotic Affordances》（2022）将语言对任务步骤的适合程度，与机器人技能在当前环境下的可执行程度结合，再选择行动。

对 Lifetime 的启发属于架构类比：导演只提出受支持的意图，本地根据实际素材、站位、路径、角色尺寸和动作空间检查能否执行；失败返回具体条件与候选修复。无需引入机器人训练或强化学习。

这个边界同样适用于场景生成：不能只判断“地图名中有凉亭”，还要验证亭内是否有可站立并可到达的区域。

来源：[论文及项目](https://say-can.github.io/)、[论文摘要](https://arxiv.org/abs/2204.01691)。

## 7. Generative Agents：上下文选择与长期记忆

《Generative Agents: Interactive Simulacra of Human Behavior》（2023）用记忆记录、检索、反思和规划组织模拟角色活动，检索考虑相关性、近期性和重要性。

Lifetime 近期可借鉴上下文选择：向导演提供相关事实、近期事件和当前目标，而不是整个地图、全量对话和全部动画数据。结构化事实与原始事件保留为权威记录，摘要用于减少上下文，不成为唯一存档。

独立 NPC agent、持续反思和每个角色自行规划属于后期研究，本阶段仍使用简单状态机。

来源：[原始论文](https://arxiv.org/abs/2304.03442)。

## 当前采用的工程原则

1. 交互层识别对象和操作，先实现固定内容的调查与交谈。
2. 剧情层维护事实、事件、条件和选择后果，区别“接受委托”与“实际到达”。
3. 导演在制作开场或关键节点续写时工作，输出有边界的结构化内容。
4. NPC 动作状态机负责执行，NavMesh 与空间验证负责证明行动可行。
5. 内容包、构建记录与游玩会话分别保存；已发生事件不被续写覆盖。
6. 生成中间结果应可检查、可保留、可修复，不能只有完全成功或完全失败两种体验。

已有第一版设计见 [director-game-v1.md](director-game-v1.md)。该设计包含后续工作，不代表调查、交谈或导演续写已经接入。
