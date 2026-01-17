/**
 * Platform-specific key simulation.
 * This MUST run on the local machine (UI part) to control the Cursor UI.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execAsync = promisify(exec);

export type Platform = 'darwin' | 'win32' | 'linux';

/**
 * Focus a specific Cursor window by workspace name, or fall back to generic activation.
 * @param workspaceName - Optional workspace folder name to match in window title
 */
export async function focusCursor(workspaceName?: string): Promise<{ success: boolean; error?: string }> {
  const platform = os.platform() as Platform;

  try {
    switch (platform) {
      case 'darwin':
        if (workspaceName) {
          // macOS: Use System Events to find and focus specific window by workspace name
          const escapedName = workspaceName.replace(/"/g, '\\"').replace(/'/g, "'\\''");
          const script = `
            tell application "System Events"
              tell process "Cursor"
                set windowList to every window
                repeat with w in windowList
                  if name of w contains "${escapedName}" then
                    perform action "AXRaise" of w
                    set frontmost to true
                    return "found"
                  end if
                end repeat
              end tell
            end tell
            return "not_found"
          `;
          const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
          if (stdout.trim() === 'not_found') {
            // Fallback to generic activation if window not found
            await execAsync('osascript -e \'tell application "Cursor" to activate\'');
          }
        } else {
          // Generic activation when no workspace name provided
          await execAsync('osascript -e \'tell application "Cursor" to activate\'');
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        break;

      case 'win32':
        if (workspaceName) {
          // Windows: Use PowerShell to find and focus specific window by title
          const escapedName = workspaceName.replace(/"/g, '`"').replace(/'/g, "''");
          await execAsync(
            'powershell -command "' +
              'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; using System.Text; public class Win32 { ' +
              '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); ' +
              '[DllImport(\"user32.dll\")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count); ' +
              '[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr hWnd); ' +
              '}\'; ' +
              '$found = $false; ' +
              'Get-Process -Name Cursor -ErrorAction SilentlyContinue | ForEach-Object { ' +
              '  $handle = $_.MainWindowHandle; ' +
              '  if ($handle -ne [IntPtr]::Zero) { ' +
              '    $sb = New-Object System.Text.StringBuilder 256; ' +
              '    [Win32]::GetWindowText($handle, $sb, 256) | Out-Null; ' +
              '    $title = $sb.ToString(); ' +
              `    if ($title -like '*${escapedName}*') { ` +
              '      [Win32]::SetForegroundWindow($handle); ' +
              '      $found = $true; ' +
              '      break; ' +
              '    } ' +
              '  } ' +
              '}; ' +
              'if (-not $found) { ' +
              '  $cursor = Get-Process -Name Cursor -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
              '  if ($cursor) { [Win32]::SetForegroundWindow($cursor.MainWindowHandle) } ' +
              '}"'
          );
        } else {
          // Generic activation when no workspace name provided
          await execAsync(
            'powershell -command "' +
              '$cursor = Get-Process -Name Cursor -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
              'if ($cursor) { ' +
              '  Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }\'; ' +
              '  [Win32]::SetForegroundWindow($cursor.MainWindowHandle) ' +
              '}"'
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        break;

      case 'linux':
        if (workspaceName) {
          // Linux: Use wmctrl to find and focus specific window by title
          try {
            // List all windows and find one with the workspace name
            const { stdout } = await execAsync('wmctrl -l');
            const lines = stdout.split('\n');
            let windowId: string | null = null;
            for (const line of lines) {
              if (line.toLowerCase().includes(workspaceName.toLowerCase()) && line.toLowerCase().includes('cursor')) {
                // Window ID is the first column
                windowId = line.split(/\s+/)[0];
                break;
              }
            }
            if (windowId) {
              await execAsync(`wmctrl -i -a ${windowId}`);
            } else {
              // Fallback to generic
              await execAsync('wmctrl -a Cursor');
            }
          } catch {
            // Fallback to xdotool if wmctrl fails
            try {
              const { stdout } = await execAsync(`xdotool search --name "${workspaceName}"`);
              const windowIds = stdout.trim().split('\n').filter(id => id);
              if (windowIds.length > 0) {
                await execAsync(`xdotool windowactivate ${windowIds[0]}`);
              } else {
                await execAsync('xdotool search --name "Cursor" windowactivate');
              }
            } catch {
              await execAsync('xdotool search --name "Cursor" windowactivate');
            }
          }
        } else {
          // Generic activation when no workspace name provided
          try {
            await execAsync('wmctrl -a Cursor');
          } catch {
            await execAsync('xdotool search --name "Cursor" windowactivate');
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        break;

      default:
        return {
          success: false,
          error: `Unsupported platform: ${platform}`,
        };
    }

    return { success: true };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
}

/**
 * Press the Enter key using platform-specific methods
 * @param workspaceName - Optional workspace folder name to target specific window
 */
export async function pressEnter(workspaceName?: string): Promise<{ success: boolean; error?: string }> {
  const platform = os.platform() as Platform;

  try {
    switch (platform) {
      case 'darwin':
        // macOS: Focus specific window first, then send Enter key
        await focusCursor(workspaceName);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await execAsync('osascript -e \'tell application "System Events" to key code 36\'');
        break;

      case 'win32':
        // Windows: Focus Cursor first, then send Enter
        await focusCursor(workspaceName);
        await execAsync(
          'powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'{ENTER}\')"'
        );
        break;

      case 'linux':
        // Linux: Focus Cursor first, then use xdotool
        await focusCursor(workspaceName);
        await execAsync('xdotool key Return');
        break;

      default:
        return {
          success: false,
          error: `Unsupported platform: ${platform}`,
        };
    }

    return { success: true };
  } catch (error: any) {
    // Handle common errors
    if (platform === 'darwin' && error.message?.includes('-25211')) {
      return {
        success: false,
        error:
          'Accessibility access not granted. Please enable accessibility for Terminal/Cursor in System Settings > Privacy & Security > Accessibility.',
      };
    }

    if (platform === 'linux' && error.message?.includes('not found')) {
      return {
        success: false,
        error: 'xdotool not found. Please install it with: sudo apt install xdotool',
      };
    }

    return {
      success: false,
      error: error.message || String(error),
    };
  }
}

/**
 * Check if the platform-specific key simulation is available
 */
export async function checkKeySimulationAvailable(): Promise<{
  available: boolean;
  error?: string;
}> {
  const platform = os.platform() as Platform;

  try {
    switch (platform) {
      case 'darwin':
        // Check if AppleScript can access System Events
        await execAsync('osascript -e \'tell application "System Events" to return "ok"\'');
        return { available: true };

      case 'win32':
        // Check if PowerShell is available
        await execAsync('powershell -command "echo ok"');
        return { available: true };

      case 'linux':
        // Check if xdotool is installed
        await execAsync('which xdotool');
        return { available: true };

      default:
        return {
          available: false,
          error: `Unsupported platform: ${platform}`,
        };
    }
  } catch (error: any) {
    return {
      available: false,
      error: error.message || String(error),
    };
  }
}
