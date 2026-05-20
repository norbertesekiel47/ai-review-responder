export type EndpointKind =
  | 'select_location'
  | 'publish_reply'
  | 'list_reviews'
  | 'list_locations'
  | 'create_profile'
  | 'delete_profile'
  | 'delete_account'
  | 'start_connect';

export interface ZernioReview {
  id: string;
  name: string;
  reviewer: { displayName: string; profilePhotoUrl: string | null; isAnonymous: boolean };
  rating: number;
  starRating: 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
  comment: string | null;
  createTime: string;
  updateTime: string;
  reviewReply: { comment: string; updateTime: string } | null;
}

export interface ZernioLocationOption {
  id: string;
  name: string;
  address: string;
}

export interface ConnectPendingMarker {
  flowId: string;
  userId: string;
  started_at: number;
  status: 'starting' | 'oauth_in_progress' | 'finalizing' | 'finalize_unknown';
  profileId?: string;
  state?: string;
  finalize_unknown_at?: string;
}

export interface ConnectStateBlob {
  businessId: string;
  profileId: string;
  userId: string;
  createdAt: number;
}

export interface ConnectLocationsBlob {
  flowId: string;
  state: string;
  connect_token: string;
  pending_data_token: string;
  profileId: string;
  businessId: string;
  userId: string;
  locations: ZernioLocationOption[];
}
