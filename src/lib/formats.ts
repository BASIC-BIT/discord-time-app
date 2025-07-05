// Discord timestamp formats
export interface DiscordFormat {
  code: string;
  label: string;
  description: string;
}

export const formats: DiscordFormat[] = [
  { code: ":d", label: "07/05/2025", description: "Short Date" },
  { code: ":D", label: "July 5, 2025", description: "Long Date" },
  { code: ":t", label: "9:30 AM", description: "Short Time" },
  { code: ":T", label: "9:30:00 AM", description: "Long Time" },
  { code: ":f", label: "July 5, 2025 9:30 AM", description: "Short Date/Time" },
  { code: ":F", label: "Saturday, July 5, 2025 9:30 AM", description: "Long Date/Time" },
  { code: ":R", label: "in 2 hours", description: "Relative Time" },
];

export function formatDiscordTimestamp(epoch: number, formatIndex: number): string {
  if (formatIndex < 0 || formatIndex >= formats.length) {
    formatIndex = 0; // Default to short date
  }
  
  const format = formats[formatIndex];
  return `<t:${epoch}${format.code}>`;
}

export function getFormatLabel(epoch: number, formatIndex: number): string {
  if (formatIndex < 0 || formatIndex >= formats.length) {
    return "Invalid format";
  }
  
  const date = new Date(epoch * 1000);
  const format = formats[formatIndex];
  
  // This is a simplified preview - Discord will render the actual format
  switch (format.code) {
    case ":d":
      return date.toLocaleDateString("en-US", { 
        month: "2-digit", 
        day: "2-digit", 
        year: "numeric" 
      });
    case ":D":
      return date.toLocaleDateString("en-US", { 
        month: "long", 
        day: "numeric", 
        year: "numeric" 
      });
    case ":t":
      return date.toLocaleTimeString("en-US", { 
        hour: "numeric", 
        minute: "2-digit", 
        hour12: true 
      });
    case ":T":
      return date.toLocaleTimeString("en-US", { 
        hour: "numeric", 
        minute: "2-digit", 
        second: "2-digit", 
        hour12: true 
      });
    case ":f":
      return date.toLocaleDateString("en-US", { 
        month: "long", 
        day: "numeric", 
        year: "numeric" 
      }) + " " + date.toLocaleTimeString("en-US", { 
        hour: "numeric", 
        minute: "2-digit", 
        hour12: true 
      });
    case ":F":
      return date.toLocaleDateString("en-US", { 
        weekday: "long",
        month: "long", 
        day: "numeric", 
        year: "numeric" 
      }) + " " + date.toLocaleTimeString("en-US", { 
        hour: "numeric", 
        minute: "2-digit", 
        hour12: true 
      });
    case ":R":
      const now = new Date();
      const diffMs = date.getTime() - now.getTime();
      const diffHours = Math.round(diffMs / (1000 * 60 * 60));
      
      if (diffHours === 0) return "now";
      if (diffHours > 0) return `in ${diffHours} hour${diffHours !== 1 ? 's' : ''}`;
      return `${Math.abs(diffHours)} hour${Math.abs(diffHours) !== 1 ? 's' : ''} ago`;
    default:
      return format.label;
  }
} 