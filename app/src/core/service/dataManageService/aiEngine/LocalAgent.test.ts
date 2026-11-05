import { describe, it } from "vitest";

describe("LocalAgent IPC stream", () => {
  it.todo("把 stdout 的单行 JSON 按顺序转换为 ACP 消息");
  it.todo("把 ACP 写流序列化后交给 local_agent_write，并向调用方传播写入失败");
  it.todo("在 local_agent_start 返回句柄前缓冲 Channel 事件，保留最早的输出");
  it.todo("将无效 JSON 或非对象 stdout 作为协议错误暴露");
  it.todo("分别收集 stderr 和 stdout，并限制保存的 stderr 尾部行数");
  it.todo("收到正常 Exited 时关闭 readable 并结束挂起的读取");
  it.todo("在异常退出和启动后立即退出时保留退出信息及 stderr 尾部");
});

describe("LocalAgentConnection with SDK agent() and paired TransformStreams", () => {
  it.todo("通过默认 ACP v1 入口完成 initialize，客户端能力不声明 fs 和 terminal");
  it.todo("用研究文件夹 cwd 和 research-workbench 的 MCP 参数创建会话");
  it.todo("仅在对方声明 loadSession 时加载保存的 ACP 会话号");
  it.todo("丢弃 session/load 期间重放的历史更新，加载后恢复转发新更新");
  it.todo("不支持 loadSession 时新建会话并返回 loaded=false");
  it.todo("session/load 失败时新建会话并返回 loaded=false");
  it.todo("原样发送提示块并返回 session/prompt 的停止原因");
  it.todo("中止信号触发 session/cancel，已中止的信号不会启动新一轮提示");
  it.todo("停止等待期间仍处理 ACP 的取消完成响应");
  it.todo("auth_required 错误产生 needs-login 状态并附带固定登录命令");
  it.todo("仅声明可用 authMethods 不判成未登录，确实要求认证时才产生 needs-login");
  it.todo("找不到程序、启动失败、退出和协议错误产生对应 agent-error 状态");
  it.todo("dispose 取消挂起请求并释放 ACP 连接，重复调用也安全");
});

describe("LocalAgent permissions", () => {
  it.todo("根据 title 中的 research-workbench 标识识别白板工具");
  it.todo("根据 rawInput 或 _meta 中的 research-workbench 标识识别白板工具");
  it.todo("没有白板标识的工具请求按本机程序权限设置处理");
  it.todo("restricted 档对白板工具自动选择第一个 allow_once");
  it.todo("ask 档对白板工具自动选择第一个 allow_once 且不发送权限卡片事件");
  it.todo("auto 档对白板工具自动选择第一个 allow_once");
  it.todo("白板工具没有 allow_once 时退回 allow_always，没有允许选项时返回 cancelled");
  it.todo("restricted 档对普通工具选择 reject_once，没有该选项时返回 cancelled");
  it.todo("auto 档对普通工具优先 allow_once，再退回 allow_always");
  it.todo("auto 档对没有任何允许选项的普通工具返回 cancelled");
  it.todo("ask 档发出保留全部选项名称和种类的事件，并等待用户选择");
  it.todo("respondPermission 只接受当前请求实际提供的 optionId");
  it.todo("respondPermission 的 null 选择返回 cancelled，并发送 null 结束卡片");
  it.todo("停止会话时把尚未回答的权限请求全部回复为 cancelled");
  it.todo("关闭面板或断开连接时取消所有权限请求，迟到的回答不影响后续请求");
  it.todo("并发权限请求不互相覆盖且能按 requestId 对应用户回答");
  it.todo("每次权限请求读取当前策略，使设置变动对复用连接生效");
});

describe("mapSessionUpdate", () => {
  it.todo("逐字文本输出映射为同一段的 text-start 和连续 text-delta");
  it.todo("思考过程映射为 reasoning-start、reasoning-delta 和 reasoning-end");
  it.todo("文本与思考或工具调用交替时结束前一段，保持消息块顺序");
  it.todo("prompt 结束时补齐最后的 text-end 或 reasoning-end 并完成消息");
  it.todo("工具调用映射为 dynamic=true 的 tool-input-available 并保留 title 和 rawInput");
  it.todo("完成的工具调用更新映射为 tool-output-available");
  it.todo("失败的工具调用更新映射为 tool-output-error");
  it.todo("增量工具更新保留已有输入和工具 id，不重复创建调用");
  it.todo("保留 usage_update 的上下文占用量，不伪造输入或输出 token 数");
  it.todo("忽略 plan 和其他尚不显示的更新以及非文本输出块");
  it.todo("输入 state 保持不变，返回新状态并为同一输入生成相同的消息块");
});

describe("research-workbench MCP launch", () => {
  it.todo("把 node、script 和 appHome 拼成名为 research-workbench 的 stdio MCP 参数");
  it.todo("启动信息缺失时返回空 MCP 列表且不启动其他服务");
});
