# CBT API v1

All JSON keys below are snake_case. UUID strings throughout. REST Supabase RPC returns JSON objects directly. Server may throw input/authorization errors. URLs and one public publishable key only in frontend. All private tables in cbt_private. Existing public tables stay locked to API roles.

## Shared SQL contract

Existing public.cbt_students(id,nis,full_name,class_code,grade_level,is_active), cbt_subjects(id,slug,name,is_active), cbt_question_bank(id,question_code,subject_id,question_number,grade_scope,prompt,options,correct_option,review_status,source_label,created_at,updated_at).

Private tables:
- staff(user_id,display_name,role,classes text[],is_active)
- slots(id smallint,label,start_time time,end_time time,is_active)
- exams(id,subject_id,title,grade_level,classes text[],opens_at,closes_at,duration_minutes,slot_id,status draft/published/closed,closed_at,question_count,grading_version integer default 1,released_at,created_by)
- exam_questions(exam_id,position integer,question_id,prompt,options jsonb,correct_option, weight numeric, image_url text nullable). Immutable after publish.
- grading_keys(exam_id,version,position,correct_option nullable where null = cancelled). Created for each published version.
- rights(id,exam_id,student_id,regular_id nullable FK rights,reason nullable,token_hash bytea,token_version integer default 0,token_expires_at,opens_at,closes_at,duration_minutes,created_at). Schedule columns nullable for regular right (read exam fallback). Makeup uses a distinct exam for alternate package; regular_id unique. Regular pair exam/student unique. token_hash is extensions.digest(normalized raw base64url token,'sha256') and indexed unique when nonnull. Token rotation increments version.
- attempts(right_id PK,started_at,deadline,write_device uuid,write_epoch int,answers jsonb default '{}',revision int default 0,saved_at,submitted_at,receipt uuid unique,submit_reason,initial_version int). Answer map keys positions, values {option: null|'A'..'D', flagged:boolean, revision:integer}.
- results(right_id,version,score numeric,correct_count,wrong_count,blank_count,created_at), PK right/version.
- audit(id,actor,exam_id,action,detail jsonb,created_at).

Base defines cbt_private.grade(p_right uuid,p_version integer) returns void, persists immutable result per right/version (using submitted snapshot). Student SQL finalizes attempts then calls grade with exam grading_version; staff calls it on regrade. For deadline use min(attempt.deadline, exam.closed_at when present); after write/timer wait use clock_timestamp(). Expired rights may allow late login for receipt if attempt exists and token has not expired (default issue expiry max(close,now)+30d).

## Student

cbt_student_login(p_identity text,p_token text,p_device uuid) returns {ok:false} or {ok:true,session, ...state}; use NIS or exact normalized name and token. Device UUID per tab, new on actual duplicate/new tab; reload recovers session & leases if same device. Student RPC accepts {p_session,p_action,p_data}. state/start/claim include p_data.device. save/submit include device, epoch, and answers map position to {option,flagged,revision}; revision strictly increasing per position within lease, authoritative revision monotonic across leases. submit retries on existing final return same receipt independent of lease, provided session valid. Use safe codes for expected conflicts/deadline, frontend treats ok:false as expected.
State shape for successful responses {ok:true,status:'waiting'|'ready'|'active'|'final'|'closed', server_now, right_id,title,student_name,class_code,opens_at,closes_at,duration_minutes,deadline,write_epoch,writable,revision,saved_at,answers,questions:[{position,prompt,options,weight,image_url}],receipt,submitted_at,submit_reason,score}. Questions/answers only when active; may omit questions for save (frontend merges). Never return correct options, question bank id, results detail or token. Null score until release. Claim explicit only. Session expiry/revocation triggers generic login requirement. Agent can refine status error shape with notification.

## Staff

Single cbt_staff RPC {p_action,p_data:{...}}. Auth session required. Success return JSON object or array. Profile validated on each action. Admin all classes. Teacher exam access requires all exam classes within assigned scope; all authorized teachers can use common question bank. No student rows outside staff scope. Returned exam rows include id,title,subject_id,grade_level,classes,opens_at,closes_at,duration_minutes,slot_id,status,question_count,grading_version,released_at.

- dashboard {} -> {profile:{display_name,role,classes},subjects:[{id,name,slug}],classes:[{class_code,grade_level,count}],slots:[{id,label,start_time,end_time,is_active}],exams:[exam],staff?:[{user_id,email,display_name,role,classes,is_active}]}
- bank {subject_id} -> array of bank rows including id,prompt,options,correct_option,review_status,grade_scope,question_number,weight,image_url.
- question_save {id?,subject_id,grade_scope,prompt,options,correct_option,review_status,weight?,image_url?} -> {id}. Archive with same action and all fields. grade_scope text (store informational scope). status draft/approved/archived.
- slot_save {id,label,start_time,end_time,is_active} -> {id}; admin only, ID 1..3.
- exam_save {id?,subject_id,title,grade_level,classes,opens_at,closes_at,duration_minutes,slot_id?,question_count} -> {id}; for draft all fields, published may edit schedule before opening/attempt. Closed immutable.
- exam_detail {exam_id} -> {exam,questions:[{position,question_id,prompt,options,correct_option,weight,image_url}],participants:[{right_id,student_id,nis,full_name,class_code,has_token,regular_id,reason,started_at,submitted_at,receipt,score,correct_count,wrong_count,blank_count}],audit:[{action,created_at,detail}],candidates:[{id,nis,full_name,class_code}]}.
- publish {exam_id,question_ids:[uuid]} -> {id}; exact exam count 1..40 (40 default), distinct approved subject questions. Selected classes' active students become eligible. Can create a separate published package with empty automatic enrollment via exam_save makeup_only:true (visible in dashboard; still requires target class scope); targeted makeup uses this.
- close {exam_id} -> {id}. Scores after server finalization.
- participants {exam_id,student_ids:[uuid],enabled:boolean} -> {count}; scope valid and no attempt for removal. Regular roster inserted at publish. For UI use candidates/participants from exam_detail.
- tokens {exam_id,right_ids:[uuid],mode:'issue'|'rotate'|'revoke'} -> [{right_id,nis,full_name,class_code,token}]; issue only missing, rotate existing/replace, revoke returns empty array.
- makeup {regular_id,exam_id,reason,opens_at,closes_at,duration_minutes} -> {right_id,token}; exam_id must be distinct published makeup_only same subject/grade and class, questions disjoint from regular, one makeup per regular. Schedule within target exam slot. Return token once.
- correct {exam_id,position,correct_option:null|'A'|'B'|'C'|'D',reason,expected_version} -> {version}; new grading version. Correction requires all exam work ended, hides prior release until explicit release. Retrying same expected_version/current matching key returns version.
- release {exam_id} -> {released_at}; closed by time or manual, all attempts finalized. Linked makeup must be finished before release.
- staff_save {email,display_name,role:'admin'|'teacher',classes,is_active} -> {user_id}; admin-only, Auth account must already exist. Last admin/self-disable guard.

Additional staff actions: `finalize {exam_id}` processes due attempts and returns `{count}`. `extend {exam_id,right_id,extra_minutes,reason}` extends a live attempt up to the right's scheduled close and returns `{deadline}`. `official {exam_id,right_id,is_makeup_official,reason}` selects whether a finalized makeup is official and returns `{right_id}`. `correction_preview` accepts the same input as `correct` and returns `{affected,finalized,review}`. Staff detail includes `attempt_status`, `saved_at`, `submit_reason`, and `official_result`.
