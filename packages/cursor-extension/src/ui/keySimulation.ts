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
 * Focus the Cursor application window
 */
export async function focusCursor(): Promise<{ success: boolean; error?: string }> {
  const platform = os.platform() as Platform;

  try {
    switch (platform) {
      case 'darwin':
        // macOS: Activate Cursor using AppleScript
        await execAsync('osascript -e \'tell application "Cursor" to activate\'');
        // Small delay to ensure window is focused
        await new Promise((resolve) => setTimeout(resolve, 100));
        break;

      case 'win32':
        // Windows: Use PowerShell to bring Cursor to foreground
        await execAsync(
          'powershell -command "' +
            '$cursor = Get-Process -Name Cursor -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
            'if ($cursor) { ' +
            '  Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }\'; ' +
            '  [Win32]::SetForegroundWindow($cursor.MainWindowHandle) ' +
            '}"'
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        break;

      case 'linux':
        // Linux: Use wmctrl or xdotool to focus Cursor
        try {
          await execAsync('wmctrl -a Cursor');
        } catch {
          // Fallback to xdotool if wmctrl fails
          await execAsync('xdotool search --name "Cursor" windowactivate');
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
 */
export async function pressEnter(): Promise<{ success: boolean; error?: string }> {
  const platform = os.platform() as Platform;

  try {
    switch (platform) {
      case 'darwin':
        // macOS: Use AppleScript to activate Cursor and send Enter key
        // We target Cursor specifically to ensure the key goes to the right app
        await execAsync(
          'osascript -e \'tell application "Cursor" to activate\' -e \'delay 0.1\' -e \'tell application "System Events" to key code 36\''
        );
        break;

      case 'win32':
        // Windows: Focus Cursor first, then send Enter
        await focusCursor();
        await execAsync(
          'powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'{ENTER}\')"'
        );
        break;

      case 'linux':
        // Linux: Focus Cursor first, then use xdotool
        await focusCursor();
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
