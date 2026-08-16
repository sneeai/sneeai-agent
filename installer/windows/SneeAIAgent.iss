#ifndef AgentVersion
  #error AgentVersion is required
#endif
#ifndef PayloadDirectory
  #error PayloadDirectory is required
#endif
#ifndef LauncherPath
  #error LauncherPath is required
#endif
#ifndef OutputDirectory
  #error OutputDirectory is required
#endif

[Setup]
AppId={{D3163531-9CB9-4BB1-AED7-779267B37E84}
AppName=SneeAI Agent
AppVersion={#AgentVersion}
AppPublisher=SneeAI
DefaultDirName={localappdata}\Programs\SneeAI\Agent
DefaultGroupName=SneeAI
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDirectory}
OutputBaseFilename=sneeai-agent-{#AgentVersion}-windows-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
CloseApplications=no
RestartApplications=no
UninstallDisplayName=SneeAI Agent
UsePreviousAppDir=yes

[Files]
Source: "{#PayloadDirectory}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#LauncherPath}"; DestDir: "{app}"; DestName: "sneeai-agent-launcher.exe"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SneeAIAgent"; ValueData: """{app}\sneeai-agent-launcher.exe"""; Flags: uninsdeletevalue

[Run]
Filename: "{app}\sneeai-agent-launcher.exe"; Flags: nowait runhidden

[UninstallRun]
Filename: "{app}\sneeai-agent-launcher.exe"; Parameters: "--stop"; Flags: runhidden waituntilterminated skipifdoesntexist

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Launcher: String;
begin
  Result := '';
  Launcher := ExpandConstant('{app}\sneeai-agent-launcher.exe');
  if FileExists(Launcher) then
    if (not Exec(Launcher, '--stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
      Result := 'SneeAI Agent could not be stopped before installation.';
end;
