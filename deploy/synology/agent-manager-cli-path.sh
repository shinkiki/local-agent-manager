# Agent Manager: 앱이 업데이트하는 에이전트 CLI는 ~/.local/bin에 있다(deploy/synology/README.md).
# 로그인 셸은 /etc/profile이 PATH를 다시 세우므로, 그 뒤에도 이 폴더가 /usr/local/bin보다 앞에 오게 한다.
case "${PATH}" in
  "${HOME}/.local/bin"|"${HOME}/.local/bin:"*) ;;
  *) PATH="${HOME}/.local/bin:${PATH}" ;;
esac
