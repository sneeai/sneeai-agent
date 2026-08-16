#define UNICODE
#define _UNICODE

#include <windows.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <wchar.h>

static BOOL sibling_path(const wchar_t *name, wchar_t *output, DWORD output_count) {
    DWORD length = GetModuleFileNameW(NULL, output, output_count);
    if (length == 0 || length >= output_count) return FALSE;
    wchar_t *separator = wcsrchr(output, L'\\');
    if (separator == NULL) return FALSE;
    separator[1] = L'\0';
    return wcscat_s(output, output_count, name) == 0;
}

static BOOL same_path(const wchar_t *left, const wchar_t *right) {
    wchar_t normalized_left[MAX_PATH];
    wchar_t normalized_right[MAX_PATH];
    DWORD left_length = GetFullPathNameW(left, MAX_PATH, normalized_left, NULL);
    DWORD right_length = GetFullPathNameW(right, MAX_PATH, normalized_right, NULL);
    if (left_length == 0 || left_length >= MAX_PATH || right_length == 0 || right_length >= MAX_PATH) return FALSE;
    return _wcsicmp(normalized_left, normalized_right) == 0;
}

static BOOL process_matches(DWORD process_id, const wchar_t *agent_path, HANDLE *process_out) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, process_id);
    if (process == NULL) return FALSE;
    wchar_t image[MAX_PATH];
    DWORD length = MAX_PATH;
    if (!QueryFullProcessImageNameW(process, 0, image, &length) || !same_path(image, agent_path)) {
        CloseHandle(process);
        return FALSE;
    }
    *process_out = process;
    return TRUE;
}

static int stop_agent(const wchar_t *agent_path) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return 1;
    PROCESSENTRY32W entry = {0};
    entry.dwSize = sizeof(entry);
    BOOL found = Process32FirstW(snapshot, &entry);
    int result = 0;
    while (found) {
        if (entry.th32ProcessID != GetCurrentProcessId()) {
            HANDLE process = NULL;
            if (process_matches(entry.th32ProcessID, agent_path, &process)) {
                if (!TerminateProcess(process, 0) || WaitForSingleObject(process, 10000) == WAIT_TIMEOUT) result = 1;
                CloseHandle(process);
            }
        }
        found = Process32NextW(snapshot, &entry);
    }
    CloseHandle(snapshot);
    return result;
}

static BOOL agent_is_running(const wchar_t *agent_path) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return FALSE;
    PROCESSENTRY32W entry = {0};
    entry.dwSize = sizeof(entry);
    BOOL found = Process32FirstW(snapshot, &entry);
    BOOL running = FALSE;
    while (found && !running) {
        HANDLE process = NULL;
        if (process_matches(entry.th32ProcessID, agent_path, &process)) {
            running = TRUE;
            CloseHandle(process);
        }
        found = Process32NextW(snapshot, &entry);
    }
    CloseHandle(snapshot);
    return running;
}

static int start_agent(const wchar_t *agent_path) {
    if (agent_is_running(agent_path)) return 0;
    wchar_t command_line[(MAX_PATH * 2) + 8];
    if (swprintf_s(command_line, _countof(command_line), L"\"%ls\"", agent_path) < 0) return 1;
    wchar_t working_directory[MAX_PATH];
    if (wcscpy_s(working_directory, MAX_PATH, agent_path) != 0) return 1;
    wchar_t *separator = wcsrchr(working_directory, L'\\');
    if (separator == NULL) return 1;
    *separator = L'\0';

    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    BOOL created = CreateProcessW(
        agent_path,
        command_line,
        NULL,
        NULL,
        FALSE,
        CREATE_NO_WINDOW | DETACHED_PROCESS,
        NULL,
        working_directory,
        &startup,
        &process
    );
    if (!created) return 1;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 0;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show_command) {
    (void)instance;
    (void)previous;
    (void)command_line;
    (void)show_command;
    wchar_t agent_path[MAX_PATH];
    if (!sibling_path(L"sneeai-agent.exe", agent_path, MAX_PATH)) return 1;

    int argument_count = 0;
    wchar_t **arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count);
    BOOL stop = arguments != NULL && argument_count == 2 && wcscmp(arguments[1], L"--stop") == 0;
    if (arguments != NULL) LocalFree(arguments);
    return stop ? stop_agent(agent_path) : start_agent(agent_path);
}
