import { basename } from "node:path";
import { createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function getZshPath() {
  if (process.env.PI_USER_BASH_SHELL) return process.env.PI_USER_BASH_SHELL;
  if (process.env.SHELL && basename(process.env.SHELL) === "zsh") return process.env.SHELL;
  return "/bin/zsh";
}

export default function (pi: ExtensionAPI) {
  const local = createLocalBashOperations();

  pi.on("user_bash", () => ({
    operations: {
      exec(command, cwd, options) {
        const zshCommand = `exec ${shellQuote(getZshPath())} -fc ${shellQuote(command)}`;
        return local.exec(zshCommand, cwd, options);
      },
    },
  }));
}
