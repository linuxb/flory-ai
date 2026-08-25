package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"cloud.google.com/go/storage"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
)

// GCS stores tool views in a Google Cloud Storage bucket.
//
// The client honours STORAGE_EMULATOR_HOST, so a local fake-gcs-server and
// production GCS run the same code path with no branching here.
type GCS struct {
	client *storage.Client
	bucket string
}

// NewGCS connects to the named bucket.
//
// Against an emulator it skips authentication, because fake-gcs-server has no
// credentials to present and application default credentials would fail before
// the first request.
func NewGCS(ctx context.Context, bucket string) (*GCS, error) {
	if bucket == "" {
		return nil, errors.New("blob: GCS bucket name is empty")
	}
	var options []option.ClientOption
	if os.Getenv("STORAGE_EMULATOR_HOST") != "" {
		options = append(options, option.WithoutAuthentication())
	}
	client, err := storage.NewClient(ctx, options...)
	if err != nil {
		return nil, fmt.Errorf("blob: connect to GCS: %w", err)
	}
	return &GCS{client: client, bucket: bucket}, nil
}

// Close releases the underlying client.
func (store *GCS) Close() error {
	return store.client.Close()
}

// Put writes content under name unless that name already exists.
//
// The DoesNotExist precondition makes concurrent publishers of the same view
// converge instead of racing: the name is the digest of the content, so an
// object that is already there is already correct, and PreconditionFailed is
// success rather than a conflict. Retrying this write is safe for the same
// reason -- which is exactly what a tool call is not, and why nothing retries
// one of those.
func (store *GCS) Put(ctx context.Context, name string, content []byte) error {
	writer := store.client.Bucket(store.bucket).Object(name).If(storage.Conditions{DoesNotExist: true}).NewWriter(ctx)
	if _, err := writer.Write(content); err != nil {
		_ = writer.Close()
		return fmt.Errorf("blob: write %s: %w", name, err)
	}
	if err := writer.Close(); err != nil {
		if alreadyStored(err) {
			return nil
		}
		return fmt.Errorf("blob: close %s: %w", name, err)
	}
	return nil
}

// Get returns the stored content, or ErrNotFound.
func (store *GCS) Get(ctx context.Context, name string) ([]byte, error) {
	reader, err := store.client.Bucket(store.bucket).Object(name).NewReader(ctx)
	if err != nil {
		if errors.Is(err, storage.ErrObjectNotExist) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("blob: open %s: %w", name, err)
	}
	defer reader.Close()
	content, err := io.ReadAll(reader)
	if err != nil {
		return nil, fmt.Errorf("blob: read %s: %w", name, err)
	}
	return content, nil
}

func alreadyStored(err error) bool {
	var apiError *googleapi.Error
	return errors.As(err, &apiError) && apiError.Code == 412
}

// EnsureBucket creates the bucket if it does not exist.
//
// Local development and CI point at fake-gcs-server, which starts empty, so the
// topology has to be able to provision its own bucket. It refuses to run against
// real GCS: bucket creation there is a deployment decision with billing and
// retention consequences, not something a service should do on startup.
func (store *GCS) EnsureBucket(ctx context.Context, projectID string) error {
	if os.Getenv("STORAGE_EMULATOR_HOST") == "" {
		return errors.New("blob: EnsureBucket is for a storage emulator only; provision real GCS buckets out of band")
	}
	err := store.client.Bucket(store.bucket).Create(ctx, projectID, nil)
	if err == nil || alreadyStored(err) || alreadyExists(err) {
		return nil
	}
	return fmt.Errorf("blob: create bucket %s: %w", store.bucket, err)
}

func alreadyExists(err error) bool {
	var apiError *googleapi.Error
	return errors.As(err, &apiError) && apiError.Code == 409
}
