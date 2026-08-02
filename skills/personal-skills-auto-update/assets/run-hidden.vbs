Option Explicit

Dim arguments
Dim command
Dim index
Dim shell

Set arguments = WScript.Arguments
If arguments.Count = 0 Then
    WScript.Quit 2
End If

command = QuoteArgument(arguments(0))
For index = 1 To arguments.Count - 1
    command = command & " " & QuoteArgument(arguments(index))
Next

Set shell = CreateObject("WScript.Shell")
WScript.Quit shell.Run(command, 0, True)

Function QuoteArgument(value)
    QuoteArgument = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
