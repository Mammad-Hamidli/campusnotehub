import { describe, expect, it } from 'vitest';
import type { PostRecord } from '@/lib/firebase/repositories/posts';
import { serializePost, type PostAuthor } from './serialize';

/**
 * The author's picture on the wire. Staff post in the same feed as everyone
 * else, so their avatar follows the same rule - the role must never decide it.
 */

const now = new Date('2026-10-06T12:00:00Z');
const post: PostRecord = {
  id: 'p1',
  authorId: 'admin1',
  body: 'Welcome to the new term',
  visibility: 'PUBLIC',
  universityId: null,
  parentPostId: null,
  likeCount: 0,
  commentCount: 0,
  shareCount: 0,
  isPinned: false,
  isDeleted: false,
  createdAt: now,
  updatedAt: now,
  editedAt: null,
  audience: ['PUBLIC'],
  tagSlugs: [],
  tags: [],
  media: [],
};

const admin: PostAuthor = {
  id: 'admin1',
  nickname: 'campus_admin',
  fullName: 'Campus Admin',
  avatarUrl: '/api/media/adminAvatar',
  role: 'ADMIN',
  isVerified: true,
  headline: null,
};

const avatarFor = (author: PostAuthor | null, viewer: { id: string; verificationStatus: string } | null) =>
  serializePost(post, { author, university: null, viewer }).author.avatarUrl;

describe('serializePost - author avatar', () => {
  it("shows an admin's picture to signed-out visitors, other members and the admin", () => {
    expect(avatarFor(admin, null)).toBe('/api/media/adminAvatar');
    expect(avatarFor(admin, { id: 'student1', verificationStatus: 'UNVERIFIED' })).toBe('/api/media/adminAvatar');
    expect(avatarFor(admin, { id: 'admin1', verificationStatus: 'VERIFIED' })).toBe('/api/media/adminAvatar');
    expect(serializePost(post, { author: admin, university: null }).author.role).toBe('ADMIN');
  });

  it('still honours the privacy setting, whatever the role', () => {
    const hidden = { ...admin, showAvatar: 'PRIVATE' };
    expect(avatarFor(hidden, { id: 'student1', verificationStatus: 'VERIFIED' })).toBeNull();
    expect(avatarFor(hidden, { id: 'admin1', verificationStatus: 'VERIFIED' })).toBe('/api/media/adminAvatar');
  });

  it('is null - the initials fallback - without a picture or without an author document', () => {
    expect(avatarFor({ ...admin, avatarUrl: null }, null)).toBeNull();
    expect(avatarFor(null, null)).toBeNull();
  });
});
