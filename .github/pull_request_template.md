## 변경 내용

-

## 검증

- [ ] `npm run build`
- [ ] `cargo fmt --all --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`
- [ ] 패키징·capability·Tauri·native dependency 변경 시 `npm run tauri build -- --no-bundle`

## 안전성 확인

- [ ] 실제 자격증명, 이메일, 세션 ID, Tailnet 호스트, 로컬 절대 경로를 포함하지 않았습니다.
- [ ] 공급자 소유 저장소의 읽기 전용 경계를 유지했습니다.
- [ ] 파일 경로와 외부 명령 인자를 검증했습니다.
- [ ] 사용자 영향과 문서 변경을 함께 검토했습니다.
