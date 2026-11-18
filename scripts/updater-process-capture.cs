using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

// Read-only process metadata. No writes to the target, injection, pipe reads, or handle closure in it.
public static class UpdaterProcessCapture
{
    public sealed class Destination { public string Kind = "unknown"; public string Path; }
    public sealed class Result
    {
        public List<string> LogPaths = new List<string>();
        public Destination StandardError = new Destination();
        public List<string> Errors = new List<string>();
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsWow64Process2(IntPtr process, out ushort machine, out ushort nativeMachine);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr source, IntPtr value, IntPtr target, out IntPtr copy, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] data, UIntPtr length, out UIntPtr read);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr data, int length, out int returned);

    static IntPtr ReadPointer(IntPtr process, IntPtr address)
    {
        byte[] bytes = new byte[8]; UIntPtr read;
        if (!ReadProcessMemory(process, address, bytes, (UIntPtr)8, out read) || read.ToUInt64() != 8)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read standard-handle metadata");
        return new IntPtr(BitConverter.ToInt64(bytes, 0));
    }
    static string FilePath(IntPtr handle)
    {
        StringBuilder path = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
        if (length == 0 || length >= path.Capacity) return null;
        string value = path.ToString();
        if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + value.Substring(8);
        return value.StartsWith(@"\\?\", StringComparison.Ordinal) ? value.Substring(4) : value;
    }
    static Destination Describe(IntPtr process, IntPtr value)
    {
        if (value == IntPtr.Zero || value == new IntPtr(-1)) return new Destination { Kind = "absent" };
        IntPtr copy;
        if (!DuplicateHandle(process, value, GetCurrentProcess(), out copy, 0, false, 2))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot duplicate diagnostic handle");
        try
        {
            uint type = GetFileType(copy);
            // Never consume pipe/console output or perform a potentially blocking pipe-name query.
            return new Destination { Kind = type == 1 ? "file" : type == 3 ? "pipe" : type == 2 ? "character" : "unknown", Path = type == 1 ? FilePath(copy) : null };
        }
        finally { CloseHandle(copy); }
    }
    public static Result Inspect(int pid)
    {
        Result result = new Result();
        if (Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8)
        { result.Errors.Add("Only native x64 Windows is supported"); return result; }
        // Query + duplicate + read metadata only. No terminate, write, VM-operation or thread rights.
        IntPtr process = OpenProcess(0x0400 | 0x0040 | 0x0010, false, pid);
        if (process == IntPtr.Zero) { result.Errors.Add(new Win32Exception(Marshal.GetLastWin32Error()).Message); return result; }
        try
        {
            ushort machine, nativeMachine;
            if (!IsWow64Process2(process, out machine, out nativeMachine) || machine != 0 || nativeMachine != 0x8664)
            { result.Errors.Add("Target is not a verified native x64 process"); return result; }
            try
            {
                IntPtr basic = Marshal.AllocHGlobal(48);
                try
                {
                    int returned;
                    if (NtQueryInformationProcess(process, 0, basic, 48, out returned) != 0) throw new InvalidOperationException("Cannot query process basic information");
                    // shortcut: x64 PEB/RTL_USER_PROCESS_PARAMETERS layout, revalidate before supporting other architectures.
                    IntPtr peb = Marshal.ReadIntPtr(basic, 8);
                    IntPtr parameters = ReadPointer(process, IntPtr.Add(peb, 0x20));
                    result.StandardError = Describe(process, ReadPointer(process, IntPtr.Add(parameters, 0x30)));
                }
                finally { Marshal.FreeHGlobal(basic); }
            }
            catch (Exception e) { result.Errors.Add("stderr: " + e.Message); }

            int capacity = 65536;
            while (capacity <= 1024 * 1024)
            {
                IntPtr data = Marshal.AllocHGlobal(capacity);
                try
                {
                    int returned;
                    int status = NtQueryInformationProcess(process, 51, data, capacity, out returned);
                    if (status == unchecked((int)0xC0000004)) { capacity *= 2; continue; }
                    if (status != 0) throw new InvalidOperationException("Cannot query process handle snapshot: " + status.ToString("X8"));
                    long count = Marshal.ReadInt64(data);
                    if (count < 0 || count > (capacity - 16) / 40) throw new InvalidOperationException("Invalid bounded handle snapshot");
                    for (int i = 0; i < count; i++)
                    {
                        try
                        {
                            Destination item = Describe(process, Marshal.ReadIntPtr(data, 16 + i * 40));
                            if (item.Path != null && item.Path.EndsWith(".log", StringComparison.OrdinalIgnoreCase)
                                && !String.Equals(item.Path, result.StandardError.Path, StringComparison.OrdinalIgnoreCase)
                                && !result.LogPaths.Contains(item.Path)) result.LogPaths.Add(item.Path);
                        }
                        catch (Win32Exception) { /* The target may close a handle during the snapshot. */ }
                    }
                    return result;
                }
                finally { Marshal.FreeHGlobal(data); }
            }
            result.Errors.Add("Handle snapshot exceeded the 1 MiB diagnostic limit");
        }
        catch (Exception e) { result.Errors.Add("log handles: " + e.Message); }
        finally { CloseHandle(process); }
        return result;
    }
}
