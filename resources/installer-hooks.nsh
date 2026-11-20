; Application data and independently installed extensions belong outside $INSTDIR.
; Refuse accidental installation over a data root; never clean user data on upgrade.
!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\echo.sqlite" echo_data_conflict
  IfFileExists "$INSTDIR\runtime\echo.sqlite" echo_data_conflict echo_data_safe
  echo_data_conflict:
    MessageBox MB_OK|MB_ICONSTOP "This folder contains Echo user data. Choose a separate application folder."
    Abort
  echo_data_safe:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    Push $0
    Push $1
    Push $2
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Echo Agent"
    StrCpy $1 '"$INSTDIR\echo-desktop.exe" --login-startup --data-dir '
    StrLen $2 $1
    StrCpy $0 $0 $2
    ${If} $0 == $1
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Echo Agent"
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend
