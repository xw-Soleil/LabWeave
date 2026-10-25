use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct RunCommandResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub fn run_command(program: String, cmd_args: Vec<String>, stdin: Option<String>) -> RunCommandResult {
    let mut cmd = Command::new(&program);
    cmd.args(&cmd_args);

    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return RunCommandResult {
                code: None,
                stdout: String::new(),
                stderr: e.to_string(),
            };
        }
    };

    if let Some(stdin_data) = &stdin {
        use std::io::Write;
        if let Some(ref mut child_stdin) = child.stdin {
            let _ = child_stdin.write_all(stdin_data.as_bytes());
        }
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(e) => {
            return RunCommandResult {
                code: None,
                stdout: String::new(),
                stderr: e.to_string(),
            };
        }
    };

    RunCommandResult {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    }
}
