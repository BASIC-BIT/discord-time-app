import { invoke } from '@tauri-apps/api/core';
import { FormatStats } from './prompt';

/**
 * Initialize the stats database
 */
export async function initStats(): Promise<void> {
  try {
    await invoke('init_stats_db');
  } catch (error) {
    console.error('Error initializing stats database:', error);
  }
}

/**
 * Get format usage statistics
 */
export async function getFormatStats(): Promise<FormatStats> {
  try {
    const stats = await invoke('get_format_stats') as FormatStats;
    return stats;
  } catch (error) {
    console.error('Error getting format stats:', error);
    // Return default stats if database fails
    return {
      'd': 0,
      'D': 0,
      't': 0,
      'T': 0,
      'f': 0,
      'F': 0,
      'R': 0
    };
  }
}

/**
 * Increment usage count for a format
 */
export async function incrementFormatUsage(formatIndex: number): Promise<void> {
  try {
    // Map format index to format code
    const formatCodes = ['d', 'D', 't', 'T', 'f', 'F', 'R'];
    const formatCode = formatCodes[formatIndex];
    
    if (!formatCode) {
      console.error('Invalid format index:', formatIndex);
      return;
    }
    
    await invoke('increment_format_usage', { format: formatCode });
  } catch (error) {
    console.error('Error incrementing format usage:', error);
  }
}

/**
 * Get the most used format index based on stats
 */
export function getMostUsedFormatIndex(stats: FormatStats): number {
  const formatCodes = ['d', 'D', 't', 'T', 'f', 'F', 'R'];
  let maxCount = 0;
  let mostUsedIndex = 0;
  
  formatCodes.forEach((code, index) => {
    const count = stats[code] || 0;
    if (count > maxCount) {
      maxCount = count;
      mostUsedIndex = index;
    }
  });
  
  return mostUsedIndex;
}

/**
 * Get format usage as percentages for display
 */
export function getFormatUsagePercentages(stats: FormatStats): { [key: string]: number } {
  const total = Object.values(stats).reduce((sum, count) => sum + count, 0);
  
  if (total === 0) {
    return {};
  }
  
  const percentages: { [key: string]: number } = {};
  Object.entries(stats).forEach(([format, count]) => {
    percentages[format] = Math.round((count / total) * 100);
  });
  
  return percentages;
} 