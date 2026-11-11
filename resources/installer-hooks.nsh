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
