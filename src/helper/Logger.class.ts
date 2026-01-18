import * as fs from "fs";

export class Logger {
  public static log<T = undefined>(e: T): T {
    console.log(e);
    return e;
  }
}

export class FileLogger {
  private static buffer: string[] = [];
  private static interval: NodeJS.Timeout;
  private static _instance: null | FileLogger;
  private static logFile: string;

  public static getInstance() {
    if (!FileLogger._instance) {
      FileLogger._instance = new FileLogger();
    }
    return FileLogger._instance;
  }

  public static init(logFile: string = "/tmp/CryptOpt.log", flushIntervalMs: number = 500) {
    FileLogger.getInstance(); // Ensure instance exists to properly register cleanup task.
    FileLogger.logFile = logFile;
    fs.truncateSync(FileLogger.logFile, 0);
    FileLogger.interval = setInterval(() => FileLogger.flush(), flushIntervalMs);
  }

  public static log(message: string): void {
    const ts = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString();
    FileLogger.buffer.push(ts + ": " + message);
  }

  private static flush(): void {
    if (FileLogger.buffer.length > 0) {
      const lines = FileLogger.buffer.join("\n") + "\n";
      fs.appendFile(FileLogger.logFile, lines, (err) => {
        if (err) {
          console.error("Error writing log file:", err);
        }
      });
      this.buffer = [];
    }
  }

  public static close(): void {
    if (!FileLogger._instance) return;
    clearInterval(FileLogger.interval);
    FileLogger.flush();
    FileLogger._instance = null;
  }
}
