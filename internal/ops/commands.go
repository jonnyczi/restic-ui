package ops

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"

	"github.com/jonnyczi/restic-ui/internal/restic"
)

// EnqueueForget applies a plan's retention policy (forget, optionally +prune)
// as a background operation.
func (r *Runner) EnqueueForget(ctx context.Context, planID int64) (*Operation, error) {
	p, err := r.plans.Get(ctx, planID)
	if err != nil {
		return nil, err
	}
	if p.Retention.Empty() {
		return nil, errors.New("plan has no retention policy configured")
	}

	args := append([]string{"forget"}, p.Retention.Args()...)
	// Scope the policy to snapshots containing all of this plan's paths so
	// other plans' snapshots in the same repo are untouched.
	for _, s := range p.Sources {
		args = append(args, "--path", s)
	}
	if p.Retention.Prune {
		args = append(args, "--prune")
	}

	return r.enqueueCommand(ctx, "retention", p.RepoID, &p.ID,
		fmt.Sprintf("Applying retention policy for plan %q", p.Name), args)
}

// EnqueueRestore restores a path from a snapshot to a target directory.
func (r *Runner) EnqueueRestore(ctx context.Context, repoID int64, snapshotID, includePath, target string) (*Operation, error) {
	if snapshotID == "" || target == "" {
		return nil, errors.New("snapshot id and target path are required")
	}
	if !strings.HasPrefix(target, "/") {
		return nil, errors.New("target must be an absolute path")
	}
	args := []string{"restore", snapshotID, "--target", target}
	if includePath != "" {
		args = append(args, "--include", includePath)
	}
	return r.enqueueCommand(ctx, "restore", repoID, nil,
		fmt.Sprintf("Restoring %s from snapshot %s to %s", orAll(includePath), short(snapshotID), target), args)
}

// EnqueueCheck verifies repository integrity in the background.
func (r *Runner) EnqueueCheck(ctx context.Context, repoID int64) (*Operation, error) {
	return r.enqueueCommand(ctx, "check", repoID, nil, "Checking repository integrity", []string{"check"})
}

// snapIDRe matches restic snapshot ids (short or full hex). The UI only ever
// sends ids taken from `restic snapshots` output; anything else (flags,
// "latest", shell metacharacters) is rejected before reaching argv.
var snapIDRe = regexp.MustCompile(`^[0-9a-fA-F]{8,64}$`)

// EnqueueForgetSnapshot removes a single snapshot's record from the
// repository. Data it references stays on disk until a prune runs.
func (r *Runner) EnqueueForgetSnapshot(ctx context.Context, repoID int64, snapshotID string) (*Operation, error) {
	if !snapIDRe.MatchString(snapshotID) {
		return nil, errors.New("invalid snapshot id")
	}
	return r.enqueueCommand(ctx, "forget", repoID, nil,
		fmt.Sprintf("Forgetting snapshot %s", short(snapshotID)), []string{"forget", snapshotID})
}

// EnqueuePrune deletes data no longer referenced by any snapshot.
func (r *Runner) EnqueuePrune(ctx context.Context, repoID int64) (*Operation, error) {
	return r.enqueueCommand(ctx, "prune", repoID, nil,
		"Pruning unreferenced data from repository", []string{"prune"})
}

// EnqueueCopy copies snapshots from one repository to another (3-2-1 backups).
// Note: backend credentials are merged into one environment; copying between
// two repos of the same cloud provider with different credentials is not
// supported by restic's env model.
func (r *Runner) EnqueueCopy(ctx context.Context, srcRepoID, destRepoID int64, snapshotIDs []string) (*Operation, error) {
	if srcRepoID == destRepoID {
		return nil, errors.New("source and destination repository must differ")
	}
	srcRepo, srcRC, err := r.repos.BuildRepoConfig(ctx, srcRepoID)
	if err != nil {
		return nil, err
	}
	_, destRC, err := r.repos.BuildRepoConfig(ctx, destRepoID)
	if err != nil {
		return nil, err
	}

	// Destination is the primary repo; source travels via RESTIC_FROM_*.
	merged := destRC
	merged.Env = append(merged.Env, srcRC.Env...)
	merged.Env = append(merged.Env,
		"RESTIC_FROM_REPOSITORY="+srcRC.Repository,
		"RESTIC_FROM_PASSWORD="+srcRC.Password,
	)
	merged.ExtraArgs = append(merged.ExtraArgs, srcRC.ExtraArgs...)

	args := append([]string{"copy"}, snapshotIDs...)
	op, err := r.enqueueCommandWithConfig(ctx, "copy", destRepoID, nil,
		fmt.Sprintf("Copying snapshots from %q", srcRepo.Name), merged, args)
	return op, err
}

func orAll(s string) string {
	if s == "" {
		return "everything"
	}
	return s
}

// enqueueCommand builds the repo config at run time (inside the repo lock).
func (r *Runner) enqueueCommand(ctx context.Context, opType string, repoID int64, planID *int64, intro string, args []string) (*Operation, error) {
	return r.enqueue(ctx, opType, repoID, planID, intro, args, nil)
}

// enqueueCommandWithConfig uses a pre-built config (copy needs merged envs).
func (r *Runner) enqueueCommandWithConfig(ctx context.Context, opType string, repoID int64, planID *int64, intro string, rc restic.RepoConfig, args []string) (*Operation, error) {
	return r.enqueue(ctx, opType, repoID, planID, intro, args, &rc)
}

func (r *Runner) enqueue(ctx context.Context, opType string, repoID int64, planID *int64, intro string, args []string, rc *restic.RepoConfig) (*Operation, error) {
	// Validate repo existence up front for a friendly error.
	if _, err := r.repos.Get(ctx, repoID); err != nil {
		return nil, err
	}
	res, err := r.st.DB.ExecContext(ctx, `
		INSERT INTO operations (type, repo_id, plan_id, status, created_at)
		VALUES (?, ?, ?, 'queued', ?)`,
		opType, repoID, planID, now(),
	)
	if err != nil {
		return nil, err
	}
	opID, _ := res.LastInsertId()
	op, err := r.GetOperation(ctx, opID)
	if err != nil {
		return nil, err
	}
	r.hub.Publish(Event{Type: "op", Op: op})

	go r.runCommand(opID, repoID, intro, args, rc)
	return op, nil
}

// runCommand executes a restic command under the repo lock, streaming every
// output line into the operation log.
func (r *Runner) runCommand(opID, repoID int64, intro string, args []string, preBuilt *restic.RepoConfig) {
	lock := r.repoLock(repoID)
	lock.Lock()
	defer lock.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	r.mu.Lock()
	r.cancels[opID] = cancel
	r.mu.Unlock()
	defer func() {
		cancel()
		r.mu.Lock()
		delete(r.cancels, opID)
		r.mu.Unlock()
	}()

	logger := &opLogger{r: r, opID: opID}
	r.setStatus(opID, `status='running', started_at=?`, now())
	logger.log("info", intro)

	var rc restic.RepoConfig
	if preBuilt != nil {
		rc = *preBuilt
	} else {
		_, built, err := r.repos.BuildRepoConfig(ctx, repoID)
		if err != nil {
			logger.log("error", "Failed to prepare repository: "+err.Error())
			r.finish(opID, "error", -1)
			return
		}
		rc = built
	}

	cmd := r.restic.Command(ctx, rc, args...)
	stdout, err := cmd.StdoutPipe()
	if err == nil {
		cmd.Stderr = cmd.Stdout // interleave; restic's text output is line-based
	}
	if err != nil {
		logger.log("error", "Failed to start restic: "+err.Error())
		r.finish(opID, "error", -1)
		return
	}
	if err := cmd.Start(); err != nil {
		logger.log("error", "Failed to start restic: "+err.Error())
		r.finish(opID, "error", -1)
		return
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		if line := strings.TrimRight(scanner.Text(), " \t"); line != "" {
			logger.log("info", line)
		}
	}

	err = cmd.Wait()
	status, exitCode := "success", 0
	switch {
	case ctx.Err() != nil:
		status = "canceled"
		logger.log("warn", "Operation canceled.")
	case err != nil:
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = -1
		}
		status = "error"
		logger.log("error", fmt.Sprintf("restic exited with code %d", exitCode))
	default:
		logger.log("info", "Completed successfully.")
	}
	r.finish(opID, status, exitCode)
}

// finish records the terminal state and fires notifications.
func (r *Runner) finish(opID int64, status string, exitCode int) {
	r.setStatus(opID, `status=?, ended_at=?, exit_code=?`, status, now(), exitCode)
	r.notifyDone(opID)
}
