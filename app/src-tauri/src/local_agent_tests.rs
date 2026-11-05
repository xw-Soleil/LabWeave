#[test]
#[ignore = "第 1 步：目录包含指定的七个程序，id 唯一且启动命令非空。"]
fn catalog_has_all_agents_and_unique_ids() {}

#[test]
#[ignore = "第 1 步：核对启动参数、固定安装版本、登录命令和未实测标记。"]
fn catalog_matches_fixed_commands_and_tested_flags() {}

#[test]
#[ignore = "第 1 步：目录和进程事件的 JSON 字段与前端 camelCase 类型一致。"]
fn ipc_serialization_matches_frontend_types() {}

#[test]
#[ignore = "第 1 步：用临时目录的假可执行文件验证登录 shell、当前 PATH、常见目录的查找顺序。"]
fn executable_discovery_respects_path_order() {}

#[test]
#[ignore = "第 1 步：合并 PATH 时展开用户目录并包含 nvm 各版本的 bin。"]
fn discovery_includes_home_and_nvm_directories() {}

#[test]
#[ignore = "第 1 步：登录 shell 的 PATH 只读取一次，后续查找使用缓存。"]
fn login_shell_path_is_cached() {}

#[test]
#[ignore = "第 1 步：登录 shell 超过五秒时结束探测并返回可处理的错误。"]
fn login_shell_timeout_is_bounded() {}

#[test]
#[ignore = "第 1 步：分别检测主程序和 ACP 转接器，不能把仅有主程序当成可启动。"]
fn discovery_distinguishes_host_from_adapter() {}

#[test]
#[ignore = "第 1 步：手动路径允许匹配的可执行文件及 .exe、.cmd 后缀。"]
fn path_override_accepts_matching_executables() {}

#[test]
#[ignore = "第 1 步：手动路径拒绝错误文件名、不存在的文件、目录和不可执行文件。"]
fn path_override_rejects_invalid_files() {}

#[test]
#[ignore = "第 1 步：启动和打开终端都拒绝目录以外的程序 id。"]
fn commands_reject_unknown_agent_ids() {}

#[test]
#[ignore = "第 1 步：启动时再次校验手动路径，拒绝绕过前端校验的请求。"]
fn start_revalidates_path_override() {}

#[test]
#[ignore = "第 1 步：未设置研究文件夹时拒绝启动，工作目录只来自 ResearchRoot。"]
fn start_requires_registered_research_root() {}

#[test]
#[ignore = "第 1 步：子进程继承当前环境，只有 PATH 替换为合并后的查找路径。"]
fn start_preserves_environment_and_replaces_path() {}

#[test]
#[ignore = "第 1 步：写入允许单行 JSON 对象，包括字符串内部转义的换行。"]
fn write_accepts_single_line_json_objects() {}

#[test]
#[ignore = "第 1 步：写入拒绝实际换行、回车、空白、无效 JSON、数组、null 和标量。"]
fn write_rejects_invalid_or_multiline_payloads() {}

#[test]
#[ignore = "第 1 步：写入未知或已退出的句柄返回错误，重复停止不会 panic。"]
fn commands_handle_unknown_and_exited_processes() {}

#[test]
#[ignore = "第 1 步：用 /bin/cat 验证写入补换行、stdout 按行返回并保持顺序。"]
#[cfg(unix)]
fn cat_round_trip_preserves_json_lines() {}

#[test]
#[ignore = "第 1 步：stderr 与 stdout 分开，连续 stderr 输出按最后二百行的上限处理。"]
fn stderr_is_separate_and_bounded() {}

#[test]
#[ignore = "第 1 步：正常退出和被信号结束都只发送一次 Exited 事件。"]
fn process_exit_reports_optional_code_once() {}

#[test]
#[ignore = "第 1 步：用 /bin/cat 验证关闭整个进程组并回收进程及管道。"]
#[cfg(unix)]
fn stop_terminates_cat_process_group() {}

#[test]
#[ignore = "第 1 步：进程组中包括子进程时全部结束，忽略 SIGTERM 的进程在两秒后收到 SIGKILL。"]
#[cfg(unix)]
fn stop_escalates_to_sigkill_for_entire_group() {}

#[test]
#[ignore = "第 1 步：程序退出时停止所有登记的 AI 进程，单个失败不遗漏其他进程。"]
fn application_exit_stops_all_agents() {}

#[test]
#[ignore = "第 1 步：终端操作只接受 login 或 install，并拒绝没有对应固定命令的程序。"]
fn terminal_action_is_allowlisted() {}

#[test]
#[ignore = "第 1 步：终端命令替换成找到的绝对程序路径，正确转义空格和引号。"]
fn terminal_command_uses_escaped_absolute_executable() {}

#[test]
#[ignore = "第 1 步：非 macOS 打开终端返回可处理的错误，不执行其他命令。"]
#[cfg(not(target_os = "macos"))]
fn terminal_is_unsupported_outside_macos() {}
