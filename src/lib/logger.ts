/**
 * Enhanced logger for Tauri app that logs to both console and backend
 */

// Store original console methods
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
  debug: console.debug
};

// Create a logger that outputs to both console and collects for display
class Logger {
  private logs: Array<{ level: string; message: string; timestamp: Date }> = [];
  private maxLogs = 100;

  private addLog(level: string, ...args: any[]) {
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');

    // Add to internal log buffer
    this.logs.push({
      level,
      message,
      timestamp: new Date()
    });

    // Keep only last N logs
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Also log to original console
    (originalConsole as any)[level](...args);

    // In development, also show in the Tauri app window
    if (import.meta.env.DEV) {
      this.showInUI(level, message);
    }
  }

  private showInUI(level: string, message: string) {
    // Create or update a debug panel in the UI
    let debugPanel = document.getElementById('debug-panel');
    if (!debugPanel && document.body) {
      debugPanel = document.createElement('div');
      debugPanel.id = 'debug-panel';
      debugPanel.style.cssText = `
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        max-height: 200px;
        background: rgba(0, 0, 0, 0.9);
        color: white;
        font-family: monospace;
        font-size: 11px;
        overflow-y: auto;
        z-index: 9999;
        padding: 10px;
        display: none;
      `;
      document.body.appendChild(debugPanel);

      // Toggle with F9
      document.addEventListener('keydown', (e) => {
        if (e.key === 'F9') {
          debugPanel!.style.display = 
            debugPanel!.style.display === 'none' ? 'block' : 'none';
        }
      });
    }

    if (debugPanel) {
      const logEntry = document.createElement('div');
      const time = new Date().toLocaleTimeString();
      const color = {
        error: '#ff6b6b',
        warn: '#ffd93d',
        info: '#6bcf7f',
        debug: '#95afc0',
        log: '#ffffff'
      }[level] || '#ffffff';

      logEntry.innerHTML = `<span style="color: ${color}">[${time}] ${level.toUpperCase()}:</span> ${message}`;
      debugPanel.appendChild(logEntry);
      debugPanel.scrollTop = debugPanel.scrollHeight;

      // Keep only last 50 entries in UI
      while (debugPanel.children.length > 50) {
        debugPanel.removeChild(debugPanel.firstChild!);
      }
    }
  }

  log(...args: any[]) { this.addLog('log', ...args); }
  error(...args: any[]) { this.addLog('error', ...args); }
  warn(...args: any[]) { this.addLog('warn', ...args); }
  info(...args: any[]) { this.addLog('info', ...args); }
  debug(...args: any[]) { this.addLog('debug', ...args); }

  getLogs() { return this.logs; }
  clearLogs() { this.logs = []; }
}

// Export enhanced logger
export const logger = new Logger();

// Replace global console in development
if (import.meta.env.DEV) {
  console.log = (...args) => logger.log(...args);
  console.error = (...args) => logger.error(...args);
  console.warn = (...args) => logger.warn(...args);
  console.info = (...args) => logger.info(...args);
  console.debug = (...args) => logger.debug(...args);
  
  logger.info('Enhanced logger initialized. Press F9 to toggle debug panel.');
}