import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import type { PostVisibility } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import TopBar from '@/components/layout/TopBar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { toast } from 'sonner'
import {
  ImagePlus, X, ChevronDown, ShieldCheck, ShieldAlert,
  Loader2, Globe, Lock, Users, Clock,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Step = 'select' | 'uploading' | 'moderating' | 'compose'
type ModerationState = 'pending' | 'safe' | 'review' | 'rejected' | 'timeout' | 'error'

const VISIBILITY_OPTIONS: { value: PostVisibility; label: string; icon: typeof Globe }[] = [
  { value: 'public', label: 'Public', icon: Globe },
  { value: 'friends', label: 'Friends Only', icon: Users },
  { value: 'private', label: 'Private', icon: Lock },
]

const MAX_TAGS = 10
const MAX_TAG_LENGTH = 30
const MAX_TITLE = 100
const MAX_DESCRIPTION = 500
const MODERATION_TIMEOUT_MS = 3000

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ').trim()
}

function generateIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

export default function Create() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const idempotencyRef = useRef<string>(generateIdempotencyKey())
  const publishedRef = useRef(false)

  const [step, setStep] = useState<Step>('select')
  const [mediaUrl, setMediaUrl] = useState('')
  const [mediaPath, setMediaPath] = useState('')
  const [mediaType, setMediaType] = useState<'image' | 'video'>('image')
  const [localPreview, setLocalPreview] = useState('')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [moderationState, setModerationState] = useState<ModerationState>('pending')
  const [posting, setPosting] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  const [title, setTitle] = useState('')
  const [caption, setCaption] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<PostVisibility>('public')
  const [isChildFriendly, setIsChildFriendly] = useState(true)
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>([])

  const uploadMedia = async (file: File) => {
    if (!user) return

    // Instant local preview
    const preview = URL.createObjectURL(file)
    setLocalPreview(preview)
    const isVideo = file.type.startsWith('video/')
    setMediaType(isVideo ? 'video' : 'image')
    setStep('uploading')
    setUploadProgress(0)

    try {
      const folder = isVideo ? 'videos' : 'images'
      const ext = file.name.split('.').pop() || (isVideo ? 'mp4' : 'jpg')
      const path = `${folder}/${user.id}-${Date.now()}.${ext}`

      // Use XHR for real upload progress
      const uploadUrl = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/posts/${path}`
      const { data: { session } } = await supabase.auth.getSession()

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', uploadUrl)
        xhr.setRequestHeader('Authorization', `Bearer ${session?.access_token}`)
        xhr.setRequestHeader('x-upsert', 'true')
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const pct = Math.round((event.loaded / event.total) * 100)
            setUploadProgress(pct)
          }
        }
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve()
          else reject(new Error(`Upload failed (${xhr.status})`))
        }
        xhr.onerror = () => reject(new Error('Network error during upload'))
        xhr.send(file)
      })


      const { data: { publicUrl } } = supabase.storage
        .from('posts')
        .getPublicUrl(path)

      setMediaUrl(publicUrl)
      setMediaPath(path)
      URL.revokeObjectURL(preview)
      setLocalPreview('')

      // Start moderation immediately after upload completes
      await runModeration(publicUrl, isVideo ? 'video' : 'image')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
      URL.revokeObjectURL(preview)
      setLocalPreview('')
      setStep('select')
      setUploadProgress(0)
    }
  }

  const runModeration = async (url: string, type: 'image' | 'video') => {
    setStep('moderating')
    setModerationState('pending')

    try {
      const { data: { session } } = await supabase.auth.getSession()

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), MODERATION_TIMEOUT_MS + 500)

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/moderate-content`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ mediaUrl: url, mediaType: type }),
          signal: controller.signal,
        }
      )

      clearTimeout(timeoutId)

      if (!resp.ok) throw new Error('Moderation service unavailable')
      const result = await resp.json()

      if (result.status === 'safe') {
        setModerationState('safe')
        setStep('compose')
      } else if (result.status === 'review') {
        setModerationState('review')
        setStep('compose')
      } else if (result.status === 'rejected') {
        setModerationState('rejected')
        setStep('compose')
      } else if (result.status === 'timeout') {
        setModerationState('timeout')
        setStep('compose')
      } else {
        throw new Error('Unexpected moderation response')
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setModerationState('timeout')
        setStep('compose')
      } else {
        setModerationState('error')
        setStep('compose')
      }
    }
  }

  const addTagsFromInput = useCallback(() => {
    const parts = tagInput.split(',')
    const newTags: string[] = []
    for (const part of parts) {
      const normalized = normalizeTag(part)
      if (normalized && !tags.includes(normalized) && newTags.length + tags.length < MAX_TAGS) {
        newTags.push(normalized)
      }
    }
    if (newTags.length > 0) {
      setTags([...tags, ...newTags])
    }
    setTagInput('')
  }, [tagInput, tags])

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTagsFromInput()
    }
  }

  const removeTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag))
  }

  const handlePost = async () => {
    if (!user || !mediaUrl) return
    if (publishedRef.current) return
    if (moderationState === 'rejected') return

    addTagsFromInput()
    if (tags.length > MAX_TAGS) {
      toast.error(`Maximum ${MAX_TAGS} tags allowed`)
      return
    }

    publishedRef.current = true
    setPosting(true)

    try {
      const now = new Date().toISOString()
      const idempotencyKey = idempotencyRef.current

      // Determine final moderation + status
      const finalModeration = moderationState === 'safe' ? 'safe' : 'review'
      const finalStatus = moderationState === 'safe' ? 'published' : 'pending_moderation'
      const publishedAt = moderationState === 'safe' ? now : null

      const { data: post, error } = await supabase
        .from('posts')
        .insert({
          user_id: user.id,
          media_url: mediaUrl,
          media_path: mediaPath,
          media_type: mediaType,
          caption: caption.trim(),
          title: title.trim(),
          description: description.trim(),
          visibility,
          is_child_friendly: isChildFriendly,
          moderation_status: finalModeration,
          status: finalStatus,
          published_at: publishedAt,
          idempotency_key: idempotencyKey,
        })
        .select('id')
        .single()

      if (error) {
        if (error.code === '23505') {
          toast.info('Post already shared')
          navigate('/')
          return
        }
        throw error
      }

      // Save tags (non-critical — don't block on failure)
      if (post && tags.length > 0) {
        const tagRows = tags.map(tag => ({ post_id: post.id, tag }))
        await supabase.from('post_tags').insert(tagRows).then(({ error: tagErr }) => {
          if (tagErr) console.error('Failed to save tags:', tagErr)
        })
      }

      if (finalStatus === 'published') {
        toast.success('Post shared!')
      } else {
        toast.success('Post saved — pending safety review before publishing.')
      }
      navigate('/')
    } catch (err: unknown) {
      publishedRef.current = false
      toast.error(err instanceof Error ? err.message : 'Failed to post')
    } finally {
      setPosting(false)
    }
  }

  const retryModeration = () => {
    if (mediaUrl) runModeration(mediaUrl, mediaType)
  }

  const resetMedia = () => {
    if (localPreview) URL.revokeObjectURL(localPreview)
    setMediaUrl('')
    setMediaPath('')
    setLocalPreview('')
    setUploadProgress(0)
    setStep('select')
    setModerationState('pending')
    idempotencyRef.current = generateIdempotencyKey()
    publishedRef.current = false
  }

  const previewUrl = localPreview || mediaUrl

  return (
    <div className="pb-20">
      <TopBar
        title="New Post"
        showBack
        right={
          step === 'compose' ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-primary font-semibold"
              disabled={posting || moderationState === 'rejected'}
              onClick={handlePost}
            >
              {posting ? <Spinner className="size-4" /> : 'Share'}
            </Button>
          ) : undefined
        }
      />
      <div className="max-w-lg mx-auto px-4 py-4">
        {/* Step: Select media */}
        {step === 'select' && (
          <div
            className="aspect-square border-2 border-dashed border-border rounded-xl flex flex-col items-center justify-center gap-4 cursor-pointer hover:bg-accent/30 transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus className="size-12 text-muted-foreground" />
            <div className="text-center">
              <p className="text-sm font-medium">Tap to upload a photo or video</p>
              <p className="text-xs text-muted-foreground mt-1">Up to 1080p quality</p>
            </div>
          </div>
        )}

        {/* Step: Uploading — shows real progress with instant preview */}
        {step === 'uploading' && (
          <div className="flex flex-col items-center gap-4">
            <div className="relative aspect-square w-full max-w-xs rounded-xl overflow-hidden bg-muted">
              {mediaType === 'video' ? (
                <video src={previewUrl} className="w-full h-full object-cover" />
              ) : (
                <img src={previewUrl} alt="" className="w-full h-full object-cover" />
              )}
              <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-3">
                <p className="text-white text-sm font-medium">Uploading... {uploadProgress}%</p>
                <div className="w-48 h-1.5 bg-white/20 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-white rounded-full transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step: Moderating — brief safety check */}
        {step === 'moderating' && (
          <div className="flex flex-col items-center gap-6 py-16">
            <div className="relative aspect-square w-full max-w-xs rounded-xl overflow-hidden bg-muted">
              {mediaType === 'video' ? (
                <video src={previewUrl} className="w-full h-full object-cover" />
              ) : (
                <img src={previewUrl} alt="" className="w-full h-full object-cover" />
              )}
              <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center gap-3">
                <Loader2 className="size-10 text-white animate-spin" />
                <p className="text-white text-sm font-medium">Checking safety...</p>
              </div>
            </div>
          </div>
        )}

        {/* Step: Compose */}
        {step === 'compose' && (
          <>
            <div className="relative aspect-square rounded-xl overflow-hidden bg-muted">
              {mediaType === 'video' ? (
                <video src={previewUrl} className="w-full h-full object-cover" controls playsInline />
              ) : (
                <img src={previewUrl} alt="" className="w-full h-full object-cover" />
              )}
              <button
                className="absolute top-2 right-2 bg-black/60 rounded-full size-8 flex items-center justify-center"
                onClick={resetMedia}
              >
                <X className="size-4 text-white" />
              </button>
            </div>

            {/* Moderation status badge */}
            <div className="mt-3 flex items-center gap-2">
              {moderationState === 'safe' && (
                <Badge className="bg-green-500/15 text-green-600 border-green-500/30">
                  <ShieldCheck className="size-3.5 mr-1" /> Safe
                </Badge>
              )}
              {moderationState === 'review' && (
                <Badge className="bg-yellow-500/15 text-yellow-600 border-yellow-500/30">
                  <ShieldAlert className="size-3.5 mr-1" /> Under review
                </Badge>
              )}
              {moderationState === 'rejected' && (
                <Badge className="bg-red-500/15 text-red-600 border-red-500/30">
                  <ShieldAlert className="size-3.5 mr-1" /> Rejected
                </Badge>
              )}
              {moderationState === 'timeout' && (
                <div className="flex items-center gap-2">
                  <Badge className="bg-blue-500/15 text-blue-600 border-blue-500/30">
                    <Clock className="size-3.5 mr-1" /> Safety check timed out
                  </Badge>
                  <Button variant="outline" size="sm" onClick={retryModeration}>
                    Retry check
                  </Button>
                </div>
              )}
              {moderationState === 'error' && (
                <div className="flex items-center gap-2">
                  <Badge className="bg-muted text-muted-foreground">
                    Moderation unavailable
                  </Badge>
                  <Button variant="outline" size="sm" onClick={retryModeration}>
                    Retry
                  </Button>
                </div>
              )}
            </div>

            {moderationState === 'rejected' ? (
              <div className="mt-6 text-center py-8">
                <ShieldAlert className="size-12 text-red-500 mx-auto mb-3" />
                <p className="font-semibold text-red-600">Content rejected</p>
                <p className="text-sm text-muted-foreground mt-1">
                  This content may violate our community guidelines.
                </p>
                <Button variant="outline" className="mt-4" onClick={resetMedia}>
                  Choose different media
                </Button>
              </div>
            ) : (
              <>
                {/* Title */}
                <div className="mt-4">
                  <Input
                    placeholder="Title"
                    value={title}
                    onChange={e => setTitle(e.target.value.slice(0, MAX_TITLE))}
                    maxLength={MAX_TITLE}
                  />
                  <p className="text-xs text-muted-foreground text-right mt-1">
                    {title.length}/{MAX_TITLE}
                  </p>
                </div>

                {/* Caption */}
                <div className="mt-2">
                  <Textarea
                    placeholder="Write a caption..."
                    value={caption}
                    onChange={e => setCaption(e.target.value)}
                    maxLength={2200}
                    className="resize-none min-h-20"
                  />
                </div>

                {/* Description */}
                <div className="mt-2">
                  <Textarea
                    placeholder="Add a description (optional)..."
                    value={description}
                    onChange={e => setDescription(e.target.value.slice(0, MAX_DESCRIPTION))}
                    maxLength={MAX_DESCRIPTION}
                    className="resize-none min-h-16"
                  />
                </div>

                {/* More Options */}
                <Collapsible open={moreOpen} onOpenChange={setMoreOpen} className="mt-4">
                  <CollapsibleTrigger asChild>
                    <button className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors">
                      <ChevronDown className={cn("size-4 transition-transform", moreOpen && "rotate-180")} />
                      More Options
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-4 space-y-4">
                    {/* Child friendly */}
                    <div>
                      <p className="text-sm font-medium mb-2">Is this content suitable for children?</p>
                      <div className="flex gap-2">
                        <Button
                          variant={isChildFriendly ? "default" : "outline"}
                          size="sm"
                          onClick={() => setIsChildFriendly(true)}
                        >
                          Yes
                        </Button>
                        <Button
                          variant={!isChildFriendly ? "default" : "outline"}
                          size="sm"
                          onClick={() => setIsChildFriendly(false)}
                        >
                          No
                        </Button>
                      </div>
                    </div>

                    {/* Visibility */}
                    <div>
                      <p className="text-sm font-medium mb-2">Who can see this post?</p>
                      <div className="flex gap-2">
                        {VISIBILITY_OPTIONS.map(opt => {
                          const Icon = opt.icon
                          return (
                            <Button
                              key={opt.value}
                              variant={visibility === opt.value ? "default" : "outline"}
                              size="sm"
                              onClick={() => setVisibility(opt.value)}
                            >
                              <Icon className="size-4 mr-1.5" />
                              {opt.label}
                            </Button>
                          )
                        })}
                      </div>
                    </div>

                    {/* Tags */}
                    <div>
                      <p className="text-sm font-medium mb-2">Tags</p>
                      <Input
                        placeholder="Type a tag and press comma or enter..."
                        value={tagInput}
                        onChange={e => setTagInput(e.target.value)}
                        onKeyDown={handleTagKeyDown}
                        onBlur={addTagsFromInput}
                        maxLength={MAX_TAG_LENGTH}
                      />
                      {tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {tags.map(tag => (
                            <Badge key={tag} variant="secondary" className="gap-1">
                              #{tag}
                              <button onClick={() => removeTag(tag)} className="ml-0.5">
                                <X className="size-3" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        {tags.length}/{MAX_TAGS} tags. Separate with commas.
                      </p>
                    </div>
                  </CollapsibleContent>
                </Collapsible>

                <Button
                  className="w-full mt-6"
                  size="lg"
                  disabled={posting}
                  onClick={handlePost}
                >
                  {posting ? <Spinner className="size-4 mr-2" /> : null}
                  {moderationState === 'safe' ? 'Share Post' : 'Save (pending review)'}
                </Button>
              </>
            )}
          </>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) uploadMedia(f)
          }}
        />
      </div>
    </div>
  )
}
