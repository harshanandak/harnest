import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { withoutHarnestToken } from "./daemon-env.mjs";
import { windowsSystemCommand } from "./launch-command.mjs";

function execute(command, args, env = process.env) {
  return execFileSync(windowsSystemCommand(command), args, {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: withoutHarnestToken(env),
  });
}

let currentSid;
function userSid() {
  currentSid ??= /"(S-1-(?:\d+-)+\d+)"/i.exec(execute("whoami.exe", ["/user", "/fo", "csv", "/nh"]))?.[1];
  if (!currentSid) throw new Error("Could not determine the current Windows user SID");
  return currentSid;
}

function executeAcl(script, path, directory) {
  // Windows PowerShell needs its own module path when launched indirectly from PowerShell 7.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
  return execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    ...env,
    HARNEST_ACL_PATH: resolve(path),
    HARNEST_ACL_SID: userSid(),
    HARNEST_ACL_DIRECTORY: directory ? "1" : "0",
  }).trim();
}

const writeAcl = [
  '$ErrorActionPreference = "Stop"',
  '$path = $env:HARNEST_ACL_PATH',
  'if ($env:HARNEST_ACL_DIRECTORY -eq "1") {',
  '  $item = [System.IO.DirectoryInfo]::new($path)',
  '  $acl = [System.Security.AccessControl.DirectorySecurity]::new()',
  '  $flags = "OICI"',
  '} else {',
  '  $item = [System.IO.FileInfo]::new($path)',
  '  $acl = [System.Security.AccessControl.FileSecurity]::new()',
  '  $flags = ""',
  '}',
  // Replace the entire DACL, including existing explicit ACEs, in one write.
  '$acl.SetSecurityDescriptorSddlForm("D:P(A;$flags;FA;;;$env:HARNEST_ACL_SID)", "Access")',
  '$item.SetAccessControl($acl)',
].join("\n");

const readAcl = [
  '$ErrorActionPreference = "Stop"',
  '$acl = Get-Acl -LiteralPath $env:HARNEST_ACL_PATH',
  '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
  '$rule = $rules[0]',
  '$private = $acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rule.IdentityReference.Value -eq $env:HARNEST_ACL_SID',
  '$private = $private -and -not $rule.IsInherited -and $rule.AccessControlType -eq "Allow" -and $rule.FileSystemRights -eq "FullControl"',
  '$flags = if ($env:HARNEST_ACL_DIRECTORY -eq "1") { 3 } else { 0 }',
  'if ($private -and [int]$rule.InheritanceFlags -eq $flags -and [int]$rule.PropagationFlags -eq 0) { "private"; return }',
  '$observed = [ordered]@{',
  '  protected = $acl.AreAccessRulesProtected',
  '  ruleCount = $rules.Count',
  '  expectedSid = $env:HARNEST_ACL_SID',
  '  rules = @($rules | ForEach-Object {',
  '    [ordered]@{',
  '      sid = $_.IdentityReference.Value',
  '      type = [string]$_.AccessControlType',
  '      rights = [string]$_.FileSystemRights',
  '      inheritanceFlags = [int]$_.InheritanceFlags',
  '      propagationFlags = [int]$_.PropagationFlags',
  '      isInherited = $_.IsInherited',
  '    }',
  '  })',
  '}',
  'ConvertTo-Json -InputObject $observed -Depth 4 -Compress',
].join("\n");

function inspectWindowsAcl(path, directory) {
  try {
    return executeAcl(readAcl, path, directory);
  } catch {
    throw new Error("Could not verify the Windows ACL at " + path);
  }
}

export function hasUserOnlyWindowsAcl(path, { directory = false } = {}) {
  return inspectWindowsAcl(path, directory) === "private";
}

export function protectWindowsPath(path, { directory = false } = {}) {
  try {
    executeAcl(writeAcl, path, directory);
  } catch {
    throw new Error("Could not set a private Windows ACL at " + path);
  }
  const observed = inspectWindowsAcl(path, directory);
  if (observed !== "private") throw new Error("Expected a user-only Windows ACL at " + path + ". Observed " + observed);
}
