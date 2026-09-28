import { describe, expect, it } from 'vitest';
import { avatarSourceUrl, withPhotoSize } from './avatar-source';

const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocJ_example-Photo_Id=s96-c';

describe('avatarSourceUrl', () => {
  it('accepts a Google account photo over https', () => {
    expect(avatarSourceUrl(GOOGLE)?.hostname).toBe('lh3.googleusercontent.com');
    // An explicit default port is normalised away, so it is not "a port".
    expect(avatarSourceUrl('https://lh3.googleusercontent.com:443/a/x')).not.toBeNull();
  });

  it('refuses anything but https', () => {
    for (const url of [
      GOOGLE.replace('https:', 'http:'),
      'ftp://lh3.googleusercontent.com/a/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:image/png;base64,iVBORw0KGgo=',
    ]) {
      expect(avatarSourceUrl(url), url).toBeNull();
    }
  });

  it('refuses hosts outside *.googleusercontent.com, including look-alikes', () => {
    for (const url of [
      'https://googleusercontent.com/a/x', // the apex is not a photo host
      'https://evilgoogleusercontent.com/a/x',
      'https://lh3.googleusercontent.com.evil.example/a/x',
      'https://lh3.googleusercontent.com%2eevil.example/a/x',
      'https://example.com/lh3.googleusercontent.com/a/x',
      'https://example.com/?u=https://lh3.googleusercontent.com/a/x',
      'https://127.0.0.1/a/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/a/x',
      'https://localhost/a/x',
    ]) {
      expect(avatarSourceUrl(url), url).toBeNull();
    }
  });

  it('refuses credentials and non-default ports', () => {
    expect(avatarSourceUrl('https://user:pw@lh3.googleusercontent.com/a/x')).toBeNull();
    expect(avatarSourceUrl('https://user@lh3.googleusercontent.com/a/x')).toBeNull();
    expect(avatarSourceUrl('https://lh3.googleusercontent.com:8443/a/x')).toBeNull();
  });

  it('refuses non-strings, empty, malformed and oversized values', () => {
    for (const value of [null, undefined, 42, {}, '', 'not a url', `${GOOGLE}${'a'.repeat(2048)}`]) {
      expect(avatarSourceUrl(value)).toBeNull();
    }
  });
});

describe('withPhotoSize', () => {
  it('asks Google for the stored size instead of the 96px thumbnail', () => {
    expect(withPhotoSize(new URL(GOOGLE), 320).href).toBe(
      'https://lh3.googleusercontent.com/a/ACg8ocJ_example-Photo_Id=s320-c',
    );
    expect(withPhotoSize(new URL('https://lh3.googleusercontent.com/a/x=s96'), 320).pathname).toBe('/a/x=s320-c');
  });

  it('leaves a URL without a size suffix unchanged, host included', () => {
    const url = new URL('https://lh3.googleusercontent.com/a/photo.jpg');
    expect(withPhotoSize(url, 320).href).toBe(url.href);
  });
});
