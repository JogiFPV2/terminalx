; Menu kontekstowe Eksploratora: „Otwórz w TerminalX” na folderze i w tle folderu.
; Instalacja per użytkownik, więc wpisy idą do HKCU (bez uprawnień administratora).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCTNAME}" "" "Otwórz w ${PRODUCTNAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCTNAME}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\${PRODUCTNAME}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --open-terminal-path "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCTNAME}" "" "Otwórz w ${PRODUCTNAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCTNAME}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\${PRODUCTNAME}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --open-terminal-path "%V"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\${PRODUCTNAME}"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\${PRODUCTNAME}"
!macroend
