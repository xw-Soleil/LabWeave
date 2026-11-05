import { describe, it } from "vitest";

describe("LocalAgentTransport with an in-memory SDK agent", () => {
  it.todo("构造时不启动程序，首次 sendMessages 才启动，后续发送复用连接");
  it.todo("只取最后一条用户消息构造当前 ACP 提示");
  it.todo("首条提示包含可修改白板但须先说明的助手说明、工作区相对路径和研究上下文");
  it.todo("后续提示保留界面已有的 selected 前缀，只添加工作区提醒而不重复白板全文");
  it.todo("发送前准备共享对象引用表，确保白板 MCP 与面板使用相同的 n/e 引用");
  it.todo("返回 AI SDK 可读取的 UIMessageChunk 流，消息具有开始和结束事件");
  it.todo("load 成功时不重复发送本地历史或重放助手消息");
  it.todo("不支持 load 或 load 失败时，仅在新会话第一条提示附上最近对话的简短文字记录");
  it.todo("没有 MCP 时继续创建会话，并通过 ready 的 whiteboardTools=false 告知界面");
  it.todo("onStatus 订阅和退订有效，启动、就绪、需要登录和失败的事件不丢失");
  it.todo("权限事件传到订阅者，respondPermission 把选择传回对应 ACP 请求");
  it.todo("sendMessages 的中止信号停止提示并取消挂起权限请求");
  it.todo("dispose 用于卸载和切换来源，关闭连接并停止 Rust 进程句柄");
  it.todo("启动期间 dispose 仍会清理随后返回的进程句柄，不遗留程序");
  it.todo("启动或初始化失败时清理已获取的句柄并向状态事件和消息流报告错误");
  it.todo("reconnectToStream 返回 null");
});

describe("local agent session persistence", () => {
  it.todo("未包含 localAgent 的旧会话按原有格式正常读取");
  it.todo("通过现有写入队列保存 ACP agentId 和 sessionId，其他会话字段不变");
  it.todo("保存消息、重命名和迁移聊天存储键时保留 localAgent 字段");
  it.todo("恢复会话时仅把相同 agentId 的 ACP 会话号用于 load");
  it.todo("重建 ACP 会话后保存新会话号，失败时不覆盖原有记录");
  it.todo("无效 localAgent 数据返回存储错误，缺少字段仍兼容旧数据");
});

describe("AIEngine backend selection and settings", () => {
  it.todo("缺省设置使用 api、codex、空路径表和 restricted");
  it.todo("设置仅接受两个来源、七个程序、字符串路径表和三档权限，并正常持久化");
  it.todo("api 分支保留 DefaultChatTransport、自定义 fetch 和上下文窗口 body 的行为");
  it.todo("localAgent 分支传入当前程序和手动路径，并把同一个传输实例暴露给 localAgent 字段");
});
