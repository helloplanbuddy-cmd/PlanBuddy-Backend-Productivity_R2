# Git Clean Push TODO

## [ ] 1. Update .gitignore
- Use exact provided content (no package-lock.json ignore)
- Append root duplicate ignores: /services/, /workers/, /tests/, load-test*.js, fixed*.sql

## [ ] 2. Git add .gitignore

## [ ] 3. Verify git status
- package-lock.json staged OK
- No diagnostics/
- Clean staged changes

## [ ] 4. Git commit
git commit -m "Backend v9: cleaned repo, added lockfile, ignored diagnostics"

## [ ] 5. Git push
git push origin production-stable

## [ ] 6. Verify on GitHub
